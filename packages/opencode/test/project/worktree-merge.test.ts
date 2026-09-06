import { $ } from "bun"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import fs from "fs/promises"
import path from "path"
import { WorktreeMerge } from "../../src/worktree/merge"
import { WorktreeLifecycle } from "../../src/worktree/lifecycle"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([WorktreeMerge.node, WorktreeLifecycle.node])))
const git = Effect.fnUntraced(function* (cwd: string, args: string[]) {
  const result = yield* Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().nothrow())
  if (result.exitCode !== 0) return yield* Effect.fail(new Error(result.stderr.toString()))
  return result.text().trim()
})
const write = (directory: string, file: string, content: string | Uint8Array) =>
  Effect.promise(() => fs.writeFile(path.join(directory, file), content))
const read = (directory: string, file: string) => Effect.promise(() => fs.readFile(path.join(directory, file), "utf8"))
const fixture = Effect.fnUntraced(function* (files: Record<string, string | Uint8Array> = {}) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir({ git: true })),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
  yield* write(root.path, "base.txt", "base\n")
  yield* write(root.path, ".gitignore", ".env\n")
  yield* Effect.forEach(Object.entries(files), ([name, content]) => write(root.path, name, content))
  yield* git(root.path, ["add", "."])
  yield* git(root.path, ["commit", "-m", "base"])
  const directory = root.path + "-linked"
  yield* git(root.path, ["worktree", "add", "-b", "result", directory])
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await $`git worktree remove --force ${directory}`.cwd(root.path).quiet().nothrow()
      await fs.rm(directory, { recursive: true, force: true })
    }),
  )
  return { root: root.path, directory }
})

describe("worktree merge", () => {
  it.effect(
    "previews and stages committed, unstaged and untracked results without moving branches or merging ignored files",
    () =>
      Effect.gen(function* () {
        const input = yield* fixture()
        const service = yield* WorktreeMerge.Service
        yield* write(input.directory, "committed.txt", "commit\n")
        yield* git(input.directory, ["add", "."])
        yield* git(input.directory, ["commit", "-m", "source result"])
        yield* write(input.directory, "base.txt", "working\n")
        yield* write(input.directory, "new.txt", "new\n")
        yield* write(input.directory, ".env", "secret\n")
        const before = yield* git(input.directory, ["status", "--porcelain"])
        const preview = yield* service.preview(input)
        expect(preview.conflicts).toEqual([])
        expect(preview.files).toEqual(["base.txt", "committed.txt", "new.txt"])
        expect(yield* git(input.root, ["status", "--porcelain"])).toBe("")
        expect(yield* service.apply({ ...input, ...preview })).toBe(true)
        expect(yield* read(input.root, "base.txt")).toBe("working\n")
        expect(yield* git(input.root, ["rev-parse", "HEAD"])).toBe(preview.targetHead)
        expect(yield* git(input.directory, ["status", "--porcelain"])).toBe(before)
        expect(yield* git(input.root, ["diff", "--cached", "--name-only"])).toBe("base.txt\ncommitted.txt\nnew.txt")
        expect(
          yield* Effect.promise(() =>
            fs.access(path.join(input.root, ".env")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        expect(Exit.isFailure(yield* service.apply({ ...input, ...preview }).pipe(Effect.exit))).toBe(true)
      }),
  )

  it.effect("reports real three-way conflicts without modifying either checkout", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const service = yield* WorktreeMerge.Service
      yield* write(input.root, "base.txt", "target\n")
      yield* git(input.root, ["commit", "-am", "target"])
      yield* write(input.directory, "base.txt", "source\n")
      const preview = yield* service.preview(input)
      expect(preview.conflicts).toEqual(["base.txt"])
      expect(preview.patch).toContain("<<<<<<<")
      expect(Exit.isFailure(yield* service.apply({ ...input, ...preview }).pipe(Effect.exit))).toBe(true)
      expect(yield* read(input.root, "base.txt")).toBe("target\n")
      expect(yield* read(input.directory, "base.txt")).toBe("source\n")
      expect(yield* git(input.root, ["status", "--porcelain"])).toBe("")
    }),
  )

  it.effect("rejects changed previews, dirty targets, foreign roots, and active directory leases", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const service = yield* WorktreeMerge.Service
      const lifecycle = yield* WorktreeLifecycle.Service
      yield* write(input.directory, "base.txt", "source\n")
      const preview = yield* service.preview(input)
      yield* write(input.directory, "base.txt", "changed\n")
      expect(Exit.isFailure(yield* service.apply({ ...input, ...preview }).pipe(Effect.exit))).toBe(true)
      yield* write(input.root, "pending.txt", "user work\n")
      expect(Exit.isFailure(yield* service.preview(input).pipe(Effect.exit))).toBe(true)
      expect(yield* read(input.root, "pending.txt")).toBe("user work\n")
      yield* Effect.promise(() => fs.unlink(path.join(input.root, "pending.txt")))
      expect(
        Exit.isFailure(yield* service.preview({ root: input.directory, directory: input.root }).pipe(Effect.exit)),
      ).toBe(true)
      yield* lifecycle.acquire({ directory: input.directory, sessionID: "active" })
      expect(Exit.isFailure(yield* service.preview(input).pipe(Effect.exit))).toBe(true)
      yield* lifecycle.release({ directory: input.directory, sessionID: "active" })
      expect((yield* service.preview(input)).conflicts).toEqual([])
    }),
  )

  it.effect("protects ignored target files from tracked source collisions", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const service = yield* WorktreeMerge.Service
      yield* write(input.directory, ".env", "source secret\n")
      yield* git(input.directory, ["add", "-f", ".env"])
      yield* git(input.directory, ["commit", "-m", "tracked env"])
      yield* write(input.root, ".env", "target local\n")
      const preview = yield* service.preview(input)
      expect(Exit.isFailure(yield* service.apply({ ...input, ...preview }).pipe(Effect.exit))).toBe(true)
      expect(yield* read(input.root, ".env")).toBe("target local\n")
      expect(yield* git(input.root, ["status", "--porcelain"])).toBe("")
    }),
  )
})

it.effect("uses a persisted owner only for a missing root hint and still verifies source membership", () =>
  Effect.gen(function* () {
    const input = yield* fixture()
    const service = yield* WorktreeMerge.Service
    const lifecycle = yield* WorktreeLifecycle.Service
    yield* lifecycle.register({
      root: input.root,
      directory: input.directory,
      branch: "result",
      projectID: "merge-root-hint",
    })
    const source = `${input.root}-source`
    yield* git(input.root, ["worktree", "add", "-b", "other-result", source])
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await $`git worktree remove --force ${source}`.cwd(input.root).quiet().nothrow()
        await fs.rm(source, { recursive: true, force: true })
      }),
    )
    yield* write(source, "base.txt", "source result\n")
    yield* git(input.root, ["worktree", "remove", input.directory])
    const preview = yield* service.preview({ root: input.directory, directory: source })
    expect(preview.target).toBe(input.root)
    expect(preview.files).toEqual(["base.txt"])
    yield* Effect.promise(() => fs.mkdir(input.directory))
    yield* git(input.directory, ["init"])
    expect(Exit.isFailure(yield* service.preview({ root: input.directory, directory: source }).pipe(Effect.exit))).toBe(
      true,
    )
    expect(yield* read(source, "base.txt")).toBe("source result\n")
    expect(yield* git(input.root, ["status", "--porcelain"])).toBe("")
    yield* Effect.promise(() => fs.rm(input.directory, { recursive: true, force: true }))
    yield* lifecycle.forgetUnclaimed(input.directory)
  }),
)

describe("explicit worktree conflict resolution", () => {
  for (const choice of ["source", "target"] as const) {
    it.effect(
      `previews and applies an explicit ${choice} choice without touching the source index or either HEAD`,
      () =>
        Effect.gen(function* () {
          const input = yield* fixture()
          const service = yield* WorktreeMerge.Service
          yield* write(input.root, "base.txt", "target\n")
          yield* git(input.root, ["commit", "-am", "target conflict"])
          yield* write(input.directory, "base.txt", "staged source\n")
          yield* git(input.directory, ["add", "base.txt"])
          yield* write(input.directory, "base.txt", "source\n")
          const sourceIndex = yield* git(input.directory, ["write-tree"])
          const sourceHead = yield* git(input.directory, ["rev-parse", "HEAD"])
          const targetHead = yield* git(input.root, ["rev-parse", "HEAD"])
          const targetIndex = yield* git(input.root, ["write-tree"])
          const initial = yield* service.preview(input)
          expect(initial.unresolved).toEqual(["base.txt"])
          const resolutions = [{ path: "base.txt", choice }]
          expect(Exit.isFailure(yield* service.apply({ ...input, ...initial, resolutions }).pipe(Effect.exit))).toBe(
            true,
          )
          const preview = yield* service.preview({ ...input, resolutions })
          expect(preview.conflicts).toEqual(["base.txt"])
          expect(preview.resolutions).toEqual(resolutions)
          expect(preview.unresolved).toEqual([])
          expect(preview.patch).not.toContain("<<<<<<<")
          expect(yield* git(input.root, ["write-tree"])).toBe(targetIndex)
          expect(yield* git(input.directory, ["write-tree"])).toBe(sourceIndex)
          expect(yield* service.apply({ ...input, ...preview })).toBe(true)
          expect(yield* read(input.root, "base.txt")).toBe(`${choice}\n`)
          expect(yield* read(input.directory, "base.txt")).toBe("source\n")
          expect(yield* git(input.directory, ["write-tree"])).toBe(sourceIndex)
          expect(yield* git(input.directory, ["rev-parse", "HEAD"])).toBe(sourceHead)
          expect(yield* git(input.root, ["rev-parse", "HEAD"])).toBe(targetHead)
          expect(yield* git(input.root, ["write-tree"])).toBe(preview.mergedTree)
        }),
    )
  }

  it.effect("supports mixed choices and modify-delete without altering either checkout during partial preview", () =>
    Effect.gen(function* () {
      const input = yield* fixture({ "second.txt": "base\n", "delete.txt": "base\n" })
      const service = yield* WorktreeMerge.Service
      for (const name of ["base.txt", "second.txt", "delete.txt"]) yield* write(input.root, name, "target\n")
      yield* git(input.root, ["commit", "-am", "target conflicts"])
      yield* write(input.directory, "base.txt", "source\n")
      yield* write(input.directory, "second.txt", "source second\n")
      yield* Effect.promise(() => fs.unlink(path.join(input.directory, "delete.txt")))
      const partial = yield* service.preview({ ...input, resolutions: [{ path: "base.txt", choice: "source" }] })
      expect(partial.unresolved).toEqual(["delete.txt", "second.txt"])
      expect(Exit.isFailure(yield* service.apply({ ...input, ...partial }).pipe(Effect.exit))).toBe(true)
      expect(yield* read(input.root, "base.txt")).toBe("target\n")
      expect(yield* read(input.root, "delete.txt")).toBe("target\n")
      const preview = yield* service.preview({
        ...input,
        resolutions: [
          { path: "base.txt", choice: "source" },
          { path: "second.txt", choice: "target" },
          { path: "delete.txt", choice: "source" },
        ],
      })
      expect(preview.unresolved).toEqual([])
      expect(yield* service.apply({ ...input, ...preview })).toBe(true)
      expect(yield* read(input.root, "base.txt")).toBe("source\n")
      expect(yield* read(input.root, "second.txt")).toBe("target\n")
      expect(yield* git(input.root, ["ls-files", "delete.txt"])).toBe("")
      expect(yield* git(input.root, ["diff", "--cached", "--name-status"])).toBe("M\tbase.txt\nD\tdelete.txt")
      expect(yield* read(input.directory, "second.txt")).toBe("source second\n")
    }),
  )

  it.effect(
    "requires a fresh reviewed choice for binary conflicts and rejects stale contents, duplicate and unrelated choices",
    () =>
      Effect.gen(function* () {
        const input = yield* fixture({ "binary.bin": new Uint8Array([0, 1]) })
        const service = yield* WorktreeMerge.Service
        yield* write(input.root, "binary.bin", new Uint8Array([0, 2]))
        yield* git(input.root, ["commit", "-am", "target binary"])
        yield* write(input.directory, "binary.bin", new Uint8Array([0, 3]))
        const initial = yield* service.preview(input)
        const target = [{ path: "binary.bin", choice: "target" as const }]
        const selected = yield* service.preview({ ...input, resolutions: target })
        expect(selected.mergedTree).toBe(initial.mergedTree)
        expect(selected.reviewID).not.toBe(initial.reviewID)
        expect(
          Exit.isFailure(yield* service.apply({ ...input, ...initial, resolutions: target }).pipe(Effect.exit)),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* service
              .apply({ ...input, ...selected, resolutions: [{ path: "binary.bin", choice: "source" }] })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(yield* service.preview({ ...input, resolutions: [...target, ...target] }).pipe(Effect.exit)),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* service
              .preview({ ...input, resolutions: [{ path: "base.txt", choice: "source" }] })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const source = yield* service.preview({ ...input, resolutions: [{ path: "binary.bin", choice: "source" }] })
        yield* write(input.directory, "binary.bin", new Uint8Array([0, 4]))
        expect(Exit.isFailure(yield* service.apply({ ...input, ...source }).pipe(Effect.exit))).toBe(true)
        expect(yield* git(input.root, ["status", "--porcelain"])).toBe("")
        const fresh = yield* service.preview({ ...input, resolutions: [{ path: "binary.bin", choice: "source" }] })
        expect(yield* service.apply({ ...input, ...fresh })).toBe(true)
        expect(Array.from(yield* Effect.promise(() => fs.readFile(path.join(input.root, "binary.bin"))))).toEqual([
          0, 4,
        ])
      }),
  )

  it.effect("can retain a target-side deletion without discarding the source modification", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const service = yield* WorktreeMerge.Service
      yield* git(input.root, ["rm", "base.txt"])
      yield* git(input.root, ["commit", "-m", "target deletion"])
      yield* write(input.directory, "base.txt", "source survives\n")
      const sourceIndex = yield* git(input.directory, ["write-tree"])
      const preview = yield* service.preview({ ...input, resolutions: [{ path: "base.txt", choice: "target" }] })
      expect(preview.conflicts).toEqual(["base.txt"])
      expect(preview.unresolved).toEqual([])
      expect(yield* service.apply({ ...input, ...preview })).toBe(true)
      expect(yield* git(input.root, ["ls-files", "base.txt"])).toBe("")
      expect(yield* git(input.root, ["status", "--porcelain"])).toBe("")
      expect(yield* read(input.directory, "base.txt")).toBe("source survives\n")
      expect(yield* git(input.directory, ["write-tree"])).toBe(sourceIndex)
    }),
  )

  it.effect("preserves executable and symlink modes for explicit whole-file choices", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const service = yield* WorktreeMerge.Service
      yield* write(input.root, "run.sh", "target\n")
      yield* Effect.promise(() => fs.chmod(path.join(input.root, "run.sh"), 0o755))
      yield* Effect.promise(() => fs.symlink("target-path", path.join(input.root, "link")))
      yield* git(input.root, ["add", "."])
      yield* git(input.root, ["commit", "-m", "target modes"])
      yield* write(input.directory, "run.sh", "source\n")
      yield* Effect.promise(() => fs.symlink("source-path", path.join(input.directory, "link")))
      const preview = yield* service.preview({
        ...input,
        resolutions: [
          { path: "run.sh", choice: "target" },
          { path: "link", choice: "source" },
        ],
      })
      expect(preview.unresolved).toEqual([])
      expect(yield* service.apply({ ...input, ...preview })).toBe(true)
      expect(yield* git(input.root, ["ls-files", "--stage", "run.sh"])).toStartWith("100755 ")
      expect(yield* git(input.root, ["ls-files", "--stage", "link"])).toStartWith("120000 ")
      expect(yield* Effect.promise(() => fs.readlink(path.join(input.root, "link")))).toBe("source-path")
      expect(yield* Effect.promise(() => fs.readlink(path.join(input.directory, "link")))).toBe("source-path")
    }),
  )

  for (const kind of ["rename", "directory"]) {
    it.effect(`rejects ${kind} relationships without mutating either checkout`, () =>
      Effect.gen(function* () {
        const input = yield* fixture()
        const service = yield* WorktreeMerge.Service
        if (kind === "rename") {
          yield* git(input.root, ["mv", "base.txt", "target-name.txt"])
          yield* git(input.directory, ["mv", "base.txt", "source-name.txt"])
          yield* git(input.directory, ["commit", "-m", "source rename"])
        } else {
          yield* git(input.root, ["rm", "base.txt"])
          yield* Effect.promise(() => fs.mkdir(path.join(input.root, "base.txt")))
          yield* write(input.root, "base.txt/nested.txt", "target directory\n")
          yield* git(input.root, ["add", "."])
          yield* write(input.directory, "base.txt", "source file\n")
        }
        yield* git(input.root, ["commit", "-m", "target relationship"])
        const before = yield* git(input.directory, ["status", "--porcelain"])
        const initial = yield* service.preview(input)
        expect(initial.unresolved.length).toBeGreaterThan(0)
        const rejected = yield* service
          .preview({ ...input, resolutions: [{ path: initial.conflicts[0]!, choice: "source" }] })
          .pipe(Effect.flip)
        expect(rejected.message).toContain("separately")
        expect(yield* git(input.root, ["status", "--porcelain"])).toBe("")
        expect(yield* git(input.directory, ["status", "--porcelain"])).toBe(before)
        expect(yield* read(input.directory, kind === "rename" ? "source-name.txt" : "base.txt")).toBe(
          kind === "rename" ? "base\n" : "source file\n",
        )
        expect(yield* read(input.root, kind === "rename" ? "target-name.txt" : "base.txt/nested.txt")).toBe(
          kind === "rename" ? "base\n" : "target directory\n",
        )
      }),
    )
  }
})
