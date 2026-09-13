import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(ProjectV2.node))

function remoteID(remote: string) {
  return ProjectV2.ID.make(Hash.fast(`git-remote:${remote}`))
}

function abs(value: string) {
  return AbsolutePath.make(value)
}

function real(value: string) {
  return Effect.promise(() => fs.realpath(value)).pipe(Effect.map((value) => AbsolutePath.make(value)))
}

async function initRepo(dir: string, opts?: { commit?: boolean; remote?: string }) {
  await $`git init`.cwd(dir).quiet()
  await $`git config core.fsmonitor false`.cwd(dir).quiet()
  await $`git config commit.gpgsign false`.cwd(dir).quiet()
  await $`git config user.email test@opencode.test`.cwd(dir).quiet()
  await $`git config user.name Test`.cwd(dir).quiet()
  if (opts?.commit) await $`git commit --allow-empty -m root`.cwd(dir).quiet()
  if (opts?.remote) await $`git remote add origin ${opts.remote}`.cwd(dir).quiet()
}

async function rootCommit(dir: string) {
  return (await $`git rev-list --max-parents=0 HEAD`.cwd(dir).text()).trim()
}

describe("ProjectV2.resolve", () => {
  it.live("returns global for non-git directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("global"))
      expect(path.resolve(result.directory)).toBe(path.parse(tmp.path).root)
      expect(result.vcs).toBeUndefined()
    }),
  )

  it.live("persists an identity before the first commit or remote", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).not.toBe(ProjectV2.ID.global)
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "opencode")).text())).toBe(result.id)
      yield* Effect.promise(() => $`git commit --allow-empty -m first`.cwd(tmp.path).quiet())
      expect((yield* project.resolve(abs(tmp.path))).id).toBe(result.id)
    }),
  )

  it.live("allocates identity independently of root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).not.toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("allocates identity independently of origin", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:Acme/App.git" }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).not.toBe(remoteID("github.com/Acme/App"))
      expect(result.id).not.toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("keeps repositories independent even with equivalent origins", () =>
    Effect.gen(function* () {
      const ssh = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const https = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(ssh.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => initRepo(https.path, { commit: true, remote: "https://github.com/owner/repo.git" }))
      const project = yield* ProjectV2.Service

      const a = yield* project.resolve(abs(ssh.path))
      const b = yield* project.resolve(abs(https.path))

      expect(a.id).not.toBe(remoteID("github.com/owner/repo"))
      expect(b.id).not.toBe(a.id)
    }),
  )

  it.live("does not derive identity from file remotes", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: `file://${tmp.path}` }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).not.toBe(ProjectV2.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
    }),
  )

  it.live("retains the saved legacy id regardless of origin", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(ProjectV2.ID.make("old-id"))
    }),
  )

  it.live("persists identity before returning it", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "opencode")).text())).toBe(result.id)
      expect((yield* project.resolve(abs(tmp.path))).id).toBe(result.id)
    }),
  )

  it.live("resolves from nested directories to repo root", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "a", "b"), { recursive: true }))
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(path.join(tmp.path, "a", "b")))

      expect(result.directory).toBe(yield* real(tmp.path))
    }),
  )

  it.live("linked worktree shares the legacy identity in the common directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const worktree = `${tmp.path}-worktree`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${worktree}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      yield* Effect.promise(() => $`git worktree add ${worktree} -b test-${Date.now()}`.cwd(tmp.path).quiet())
      const project = yield* ProjectV2.Service

      const result = yield* project.resolve(abs(worktree))

      expect(result.directory).toBe(yield* real(worktree))
      expect((yield* project.resolve(abs(tmp.path))).id).toBe(result.id)
      expect(result.id).toBe(ProjectV2.ID.make("old-id"))
      expect(result.vcs?.type).toBe("git")
    }),
  )
})

const temporary = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("ProjectV2 identity lifetime", () => {
  it.live("retains legacy identity when origin is added, renamed and removed", () =>
    Effect.gen(function* () {
      const tmp = yield* temporary()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const legacy = remoteID("github.com/kafeifei/opencode")
      const file = path.join(tmp.path, ".git", "opencode")
      yield* Effect.promise(() => fs.writeFile(file, legacy))
      const project = yield* ProjectV2.Service
      expect((yield* project.resolve(abs(tmp.path))).id).toBe(legacy)
      yield* Effect.promise(() => $`git remote add origin git@github.com:kafeifei/opencode.git`.cwd(tmp.path).quiet())
      expect((yield* project.resolve(abs(tmp.path))).id).toBe(legacy)
      yield* Effect.promise(() =>
        $`git remote set-url origin https://github.com/kafeifei/Koma.git`.cwd(tmp.path).quiet(),
      )
      expect((yield* project.resolve(abs(tmp.path))).id).toBe(legacy)
      yield* Effect.promise(() => $`git remote remove origin`.cwd(tmp.path).quiet())
      expect((yield* project.resolve(abs(tmp.path))).id).toBe(legacy)
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(legacy)
    }),
  )

  it.live("retains new identity when origin changes and the repository moves", () =>
    Effect.gen(function* () {
      const tmp = yield* temporary()
      const before = path.join(tmp.path, "before")
      const after = path.join(tmp.path, "after")
      yield* Effect.promise(() => fs.mkdir(before))
      yield* Effect.promise(() => initRepo(before, { remote: "file:///old/repo" }))
      const project = yield* ProjectV2.Service
      const first = yield* project.resolve(abs(before))
      yield* Effect.promise(() => $`git remote set-url origin git@github.com:owner/renamed.git`.cwd(before).quiet())
      yield* Effect.promise(() => fs.rename(before, after))
      const moved = yield* project.resolve(abs(after))
      expect(moved.id).toBe(first.id)
      expect(moved.directory).toBe(yield* real(after))
    }),
  )

  it.live("concurrent first opens of main and linked worktree publish one complete identity", () =>
    Effect.gen(function* () {
      const tmp = yield* temporary()
      const worktree = `${tmp.path}-concurrent-worktree`
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })))
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      yield* Effect.promise(() => $`git worktree add ${worktree} -b test-concurrent`.cwd(tmp.path).quiet())
      const project = yield* ProjectV2.Service
      const results = yield* Effect.forEach(
        Array.from({ length: 24 }, (_, i) => (i % 2 ? worktree : tmp.path)),
        (directory) => project.resolve(abs(directory)),
        { concurrency: "unbounded" },
      )
      const ids = new Set(results.map((result) => result.id))
      expect(ids.size).toBe(1)
      const persisted = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, ".git", "opencode"), "utf8"))
      expect(ids.has(ProjectV2.ID.make(persisted))).toBe(true)
      expect(persisted).not.toBe("")
      const leftovers = yield* Effect.promise(() => fs.readdir(path.join(tmp.path, ".git")))
      expect(leftovers.filter((name) => name.startsWith("opencode-"))).toEqual([])
    }),
  )

  it.live("fails instead of replacing an unreadable or invalid saved identity", () =>
    Effect.gen(function* () {
      const tmp = yield* temporary()
      yield* Effect.promise(() => initRepo(tmp.path))
      const project = yield* ProjectV2.Service
      const file = path.join(tmp.path, ".git", "opencode")
      yield* Effect.promise(() => fs.mkdir(file))
      expect(Exit.isFailure(yield* Effect.exit(project.resolve(abs(tmp.path))))).toBe(true)
      expect((yield* Effect.promise(() => fs.stat(file))).isDirectory()).toBe(true)
      yield* Effect.promise(() => fs.rmdir(file))
      yield* Effect.promise(() => fs.writeFile(file, ""))
      expect(Exit.isFailure(yield* Effect.exit(project.resolve(abs(tmp.path))))).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("")
    }),
  )
})
