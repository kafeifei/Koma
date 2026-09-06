import { $ } from "bun"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { Git } from "../../src/git"
import { WorktreeArchive } from "../../src/worktree/archive"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([WorktreeArchive.node, Git.node])))

const scopedTmpdir = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir({ git: true })),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const git = Effect.fn("WorktreeArchiveTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) {
    return yield* Effect.fail(new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`))
  }
  return result.text().trim()
})

const fixture = Effect.fn("WorktreeArchiveTest.fixture")(function* () {
  const tmp = yield* scopedTmpdir()
  yield* Effect.promise(() =>
    Bun.write(
      path.join(tmp.path, ".gitignore"),
      "ignored.txt\nignored-link\n.env\nnode_modules/\nignored-empty/\nnested-repo/\n",
    ),
  )
  yield* Effect.promise(() => Bun.write(path.join(tmp.path, "tracked.txt"), "base\n"))
  yield* git(tmp.path, ["add", ".gitignore", "tracked.txt"])
  yield* git(tmp.path, ["commit", "--no-gpg-sign", "-m", "archive base"])
  const branch = yield* git(tmp.path, ["branch", "--show-current"])
  return { directory: tmp.path, branch, sessionID: "ses_archive_test" }
})

const dirty = Effect.fn("WorktreeArchiveTest.dirty")(function* (directory: string) {
  yield* Effect.promise(() => Bun.write(path.join(directory, "tracked.txt"), "staged\n"))
  yield* git(directory, ["add", "tracked.txt"])
  yield* Effect.promise(() => Bun.write(path.join(directory, "tracked.txt"), "working\n"))
  yield* Effect.promise(() => Bun.write(path.join(directory, "untracked file.txt"), "untracked\n"))
  yield* Effect.promise(() => Bun.write(path.join(directory, "ignored.txt"), "ignored\n"))
  yield* Effect.promise(() => Bun.write(path.join(directory, ".env"), "TOKEN=local\n"))
})

describe("WorktreeArchive", () => {
  it.live("captures tracked, untracked, and ignored states without changing the checkout or stash list", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* dirty(input.directory)
      const service = yield* WorktreeArchive.Service
      const before = yield* Effect.all({
        branch: git(input.directory, ["branch", "--show-current"]),
        index: git(input.directory, ["write-tree"]),
        status: git(input.directory, ["status", "--porcelain=v1", "--untracked-files=all"]),
        stash: git(input.directory, ["stash", "list"]),
      })

      const result = yield* service.capture(input)

      expect(result.hasChanges).toBe(true)
      expect(result.oid).toMatch(/^[0-9a-f]{40,64}$/)
      expect(result.snapshot.indexTree).not.toBe(result.snapshot.baseTree)
      expect(result.snapshot.workingTree).not.toBe(result.snapshot.indexTree)
      expect(result.snapshot.untrackedTree).toMatch(/^[0-9a-f]{40,64}$/)
      expect(yield* git(input.directory, ["rev-parse", result.ref])).toBe(result.oid)
      expect(yield* git(input.directory, ["branch", "--show-current"])).toBe(before.branch)
      expect(yield* git(input.directory, ["write-tree"])).toBe(before.index)
      expect(yield* git(input.directory, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(before.status)
      expect(yield* git(input.directory, ["stash", "list"])).toBe(before.stash)
      expect(yield* git(input.directory, ["ls-tree", "-r", "--name-only", `${result.ref}^3`])).toBe(
        "untracked file.txt",
      )
      expect(yield* git(input.directory, ["ls-tree", "-r", "--name-only", `${result.ref}^3`])).not.toContain(
        "ignored.txt",
      )
      expect(yield* git(input.directory, ["ls-tree", "-r", "--name-only", `${result.ref}^4`])).toBe(".env\nignored.txt")
    }),
  )

  it.live("restores staged, unstaged, and untracked state and is replay-idempotent", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* dirty(input.directory)
      yield* Effect.promise(() => Bun.write(path.join(input.directory, " leading.txt"), "leading space\n"))
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "leading.txt"), "plain\n"))
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "line\nbreak.txt"), "embedded newline\n"))
      const service = yield* WorktreeArchive.Service
      const archived = yield* service.capture(input)
      yield* git(input.directory, ["reset", "--hard", "HEAD"])
      yield* git(input.directory, ["clean", "-fd"])
      yield* Effect.promise(() => fs.rm(path.join(input.directory, "ignored.txt")))
      yield* Effect.promise(() => fs.rm(path.join(input.directory, ".env")))

      const restored = yield* service.restore({ ...input, oid: archived.oid })

      expect(restored.alreadyApplied).toBe(false)
      expect(yield* git(input.directory, ["diff", "--cached", "--", "tracked.txt"])).toContain("+staged")
      expect(yield* git(input.directory, ["diff", "--", "tracked.txt"])).toContain("+working")
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "untracked file.txt")).text())).toBe(
        "untracked\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "ignored.txt")).text())).toBe("ignored\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, ".env")).text())).toBe("TOKEN=local\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, " leading.txt")).text())).toBe(
        "leading space\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "leading.txt")).text())).toBe("plain\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "line\nbreak.txt")).text())).toBe(
        "embedded newline\n",
      )

      const replay = yield* service.restore({ ...input, oid: archived.oid })
      expect(replay.alreadyApplied).toBe(true)
      expect(replay.snapshot).toEqual(archived.snapshot)
    }),
  )

  it.live("refuses restore when the branch baseline moved or the checkout is dirty", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* dirty(input.directory)
      const service = yield* WorktreeArchive.Service
      const archived = yield* service.capture(input)
      yield* git(input.directory, ["reset", "--hard", "HEAD"])
      yield* git(input.directory, ["clean", "-fd"])
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "collision.txt"), "new work\n"))

      const dirtyExit = yield* Effect.exit(service.restore({ ...input, oid: archived.oid }))
      expect(Exit.isFailure(dirtyExit)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "collision.txt")).text())).toBe(
        "new work\n",
      )

      yield* Effect.promise(() => fs.rm(path.join(input.directory, "collision.txt")))
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "advance.txt"), "advance\n"))
      yield* git(input.directory, ["add", "advance.txt"])
      yield* git(input.directory, ["commit", "--no-gpg-sign", "-m", "advance branch"])
      const movedExit = yield* Effect.exit(service.restore({ ...input, oid: archived.oid }))
      expect(Exit.isFailure(movedExit)).toBe(true)
    }),
  )

  it.live("requires the persisted oid and clears only that exact ref value", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* dirty(input.directory)
      const service = yield* WorktreeArchive.Service
      const archived = yield* service.capture(input)
      yield* git(input.directory, ["reset", "--hard", "HEAD"])
      yield* git(input.directory, ["clean", "-fd"])

      const mismatch = yield* Effect.exit(service.restore({ ...input, oid: archived.snapshot.baseCommit }))
      expect(Exit.isFailure(mismatch)).toBe(true)
      if (Exit.isFailure(mismatch)) {
        expect(Cause.squash(mismatch.cause)).toBeInstanceOf(WorktreeArchive.ArchiveFailedError)
      }
      expect(yield* git(input.directory, ["rev-parse", archived.ref])).toBe(archived.oid)

      const clearMismatch = yield* Effect.exit(
        service.clear({ directory: input.directory, sessionID: input.sessionID, oid: archived.snapshot.baseCommit }),
      )
      expect(Exit.isFailure(clearMismatch)).toBe(true)
      expect(yield* git(input.directory, ["rev-parse", archived.ref])).toBe(archived.oid)

      yield* service.clear({ directory: input.directory, sessionID: input.sessionID, oid: archived.oid })
      yield* service.clear({ directory: input.directory, sessionID: input.sessionID, oid: archived.oid })
      const check = yield* (yield* Git.Service).run(["rev-parse", "--verify", "--quiet", archived.ref], {
        cwd: input.directory,
      })
      expect(check.exitCode).not.toBe(0)
    }),
  )

  it.live("returns the existing stable oid when capture is retried", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const service = yield* WorktreeArchive.Service
      const first = yield* service.capture(input)
      const second = yield* service.capture(input)

      expect(first.hasChanges).toBe(false)
      expect(second.oid).toBe(first.oid)
      expect(second.snapshot).toEqual(first.snapshot)
    }),
  )

  it.live("previews the conservative ignored policy and supports preserving all ignored content", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* Effect.promise(() => Bun.write(path.join(input.directory, ".env"), "TOKEN=local\n"))
      yield* Effect.promise(() => fs.mkdir(path.join(input.directory, "node_modules", "pkg"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "node_modules", "pkg", "index.js"), "module\n"))
      const service = yield* WorktreeArchive.Service

      const local = yield* service.preview(input)
      expect(local.preserved.map((entry) => entry.path)).toContain(".env")
      expect(local.skipped).toContainEqual({
        path: "node_modules",
        type: "directory",
        reason: "rebuildable dependency or cache",
        bytes: 7,
      })
      const conservative = yield* service.capture(input)
      expect(yield* git(input.directory, ["ls-tree", "-r", "--name-only", `${conservative.ref}^4`])).toBe(".env")
      const all = yield* service.capture({ ...input, ignored: "all" })
      expect(yield* git(input.directory, ["ls-tree", "-r", "--name-only", `${all.ref}^4`])).toBe(
        ".env\nnode_modules/pkg/index.js",
      )
    }),
  )

  it.live("stores an ignored symlink itself without following its target", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const input = yield* fixture()
      yield* Effect.promise(() => fs.symlink("tracked.txt", path.join(input.directory, "ignored-link")))
      const service = yield* WorktreeArchive.Service
      const archived = yield* service.capture(input)
      yield* Effect.promise(() => fs.rm(path.join(input.directory, "ignored-link")))

      yield* service.restore({ ...input, oid: archived.oid })

      expect(yield* Effect.promise(() => fs.readlink(path.join(input.directory, "ignored-link")))).toBe("tracked.txt")
    }),
  )

  it.live("preserves ignored empty directories with the ignored parent manifest", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* Effect.promise(() => fs.mkdir(path.join(input.directory, "ignored-empty", "child"), { recursive: true }))
      const service = yield* WorktreeArchive.Service
      const archived = yield* service.capture(input)
      yield* Effect.promise(() => fs.rm(path.join(input.directory, "ignored-empty"), { recursive: true }))

      yield* service.restore({ ...input, oid: archived.oid })

      expect(
        (yield* Effect.promise(() => fs.stat(path.join(input.directory, "ignored-empty", "child")))).isDirectory(),
      ).toBe(true)
    }),
  )

  it.live("resumes an ignored restore after the stash-shaped parents were already applied", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* dirty(input.directory)
      const service = yield* WorktreeArchive.Service
      const archived = yield* service.capture(input)
      yield* git(input.directory, ["reset", "--hard", "HEAD"])
      yield* git(input.directory, ["clean", "-fd"])
      yield* Effect.promise(() => fs.rm(path.join(input.directory, "ignored.txt")))
      yield* Effect.promise(() => fs.rm(path.join(input.directory, ".env")))

      yield* git(input.directory, ["stash", "apply", "--index", archived.oid])
      const restored = yield* service.restore({ ...input, oid: archived.oid })

      expect(restored.alreadyApplied).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "ignored.txt")).text())).toBe("ignored\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, ".env")).text())).toBe("TOKEN=local\n")
    }),
  )

  it.live("does not overwrite ignored content that changed before restore", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* dirty(input.directory)
      const service = yield* WorktreeArchive.Service
      const archived = yield* service.capture(input)
      yield* git(input.directory, ["reset", "--hard", "HEAD"])
      yield* git(input.directory, ["clean", "-fd"])
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "ignored.txt"), "new local value\n"))

      const result = yield* Effect.exit(service.restore({ ...input, oid: archived.oid }))

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "ignored.txt")).text())).toBe(
        "new local value\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "tracked.txt")).text())).toBe("base\n")
    }),
  )

  it.live("verifies the live worktree against the immutable archive oid", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* Effect.promise(() => Bun.write(path.join(input.directory, ".env"), "TOKEN=first\n"))
      const service = yield* WorktreeArchive.Service
      const archived = yield* service.capture(input)
      expect((yield* service.verify({ ...input, oid: archived.oid })).oid).toBe(archived.oid)

      yield* Effect.promise(() => Bun.write(path.join(input.directory, ".env"), "TOKEN=second\n"))
      const result = yield* Effect.exit(service.verify({ ...input, oid: archived.oid }))

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, ".env")).text())).toBe("TOKEN=second\n")
    }),
  )

  it.live("rejects ignored nested repositories without deleting their contents", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* Effect.promise(() => fs.mkdir(path.join(input.directory, "nested-repo", ".git"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "nested-repo", "data.txt"), "nested\n"))
      const service = yield* WorktreeArchive.Service

      const preview = yield* service.preview(input)
      expect(preview.unsupported).toContainEqual({
        path: "nested-repo/",
        type: "directory",
        reason: "nested Git repositories cannot be stored safely",
      })
      expect(Exit.isFailure(yield* Effect.exit(service.capture(input)))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "nested-repo", "data.txt")).text())).toBe(
        "nested\n",
      )
    }),
  )

  it.live("restores legacy three-parent snapshots without requiring ignored metadata", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* dirty(input.directory)
      const service = yield* WorktreeArchive.Service
      const archived = yield* service.capture(input)
      const legacy = yield* git(input.directory, [
        "commit-tree",
        archived.snapshot.workingTree,
        "-p",
        archived.snapshot.baseCommit,
        "-p",
        `${archived.oid}^2`,
        "-p",
        `${archived.oid}^3`,
        "-m",
        "legacy archive",
      ])
      yield* git(input.directory, ["update-ref", archived.ref, legacy, archived.oid])
      yield* git(input.directory, ["reset", "--hard", "HEAD"])
      yield* git(input.directory, ["clean", "-fd"])
      yield* Effect.promise(() => fs.rm(path.join(input.directory, "ignored.txt")))
      yield* Effect.promise(() => fs.rm(path.join(input.directory, ".env")))

      const restored = yield* service.restore({ ...input, oid: legacy })

      expect(restored.snapshot.ignoredTree).toBeUndefined()
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "untracked file.txt")).text())).toBe(
        "untracked\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "ignored.txt")).exists())).toBe(false)
    }),
  )
})
