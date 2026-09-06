import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import { Git } from "@/git"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Worktree } from "@/worktree"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, Git.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)

describe("worktree creation options", () => {
  it.instance(
    "offers local branches and keeps the local default ahead of its remote",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const git = yield* Git.Service
        const worktree = yield* Worktree.Service
        yield* git.run(["branch", "main"], { cwd: directory })
        yield* git.run(["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: directory })
        yield* git.run(["remote", "add", "origin", directory], { cwd: directory })
        yield* git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: directory })
        const options = yield* worktree.options()
        expect(options.hasHead).toBe(true)
        expect(options.defaultBranch).toBe("main")
        expect(options.branches).toContain("main")
        expect(options.branches).not.toContain("origin/HEAD")
      }),
    { git: true },
  )

  it.instance(
    "waits for startup scripts and checks out the selected local base",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const git = yield* Git.Service
        const worktree = yield* Worktree.Service
        yield* git.run(["branch", "task-base"], { cwd: directory })
        const base = yield* git.run(["rev-parse", "task-base"], { cwd: directory })
        yield* git.run(
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "advance"],
          {
            cwd: directory,
          },
        )
        const created = yield* worktree.create({
          baseBranch: "task-base",
          wait: true,
          startCommand: "printf ready > startup.txt",
        })
        expect(yield* Effect.promise(() => Bun.file(`${created.directory}/startup.txt`).text())).toBe("ready")
        expect((yield* git.run(["rev-parse", "HEAD"], { cwd: created.directory })).text()).toBe(base.text())
        yield* worktree.remove({ directory: created.directory })
      }),
    { git: true },
  )

  it.instance(
    "reports startup failure instead of returning a ready worktree",
    () =>
      Effect.gen(function* () {
        const worktree = yield* Worktree.Service
        const exit = yield* worktree
          .create({ name: "failed-start", wait: true, startCommand: "exit 7" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        const created = (yield* worktree.list()).find((item) => item.name === "failed-start")
        expect(created).toBeDefined()
        if (created) yield* worktree.remove({ directory: created.directory })
      }),
    { git: true },
  )

  it.instance(
    "disables isolation until the current branch has a commit",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const git = yield* Git.Service
        const worktree = yield* Worktree.Service
        yield* git.run(["checkout", "--orphan", "unborn"], { cwd: directory })
        expect(yield* worktree.options()).toEqual({ hasHead: false, branches: [] })
      }),
    { git: true },
  )

  it.instance(
    "rejects an unknown base before creating a worktree",
    () =>
      Effect.gen(function* () {
        const worktree = yield* Worktree.Service
        const before = yield* worktree.list()
        const result = yield* worktree.create({ baseBranch: "missing-base", wait: true }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* worktree.list()).toEqual(before)
      }),
    { git: true },
  )

  it.instance(
    "protects the primary checkout and ordinary unregistered directories",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const worktree = yield* Worktree.Service
        yield* Effect.promise(() => Bun.write(`${directory}/ordinary/keep.txt`, "keep"))
        expect(Exit.isFailure(yield* worktree.remove({ directory }).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* worktree.remove({ directory: `${directory}/ordinary` }).pipe(Effect.exit))).toBe(
          true,
        )
        expect(yield* Effect.promise(() => Bun.file(`${directory}/ordinary/keep.txt`).text())).toBe("keep")
      }),
    { git: true },
  )

  it.instance("disables isolation for a non-Git directory", () =>
    Effect.gen(function* () {
      const worktree = yield* Worktree.Service
      expect(yield* worktree.options()).toEqual({ hasHead: false, branches: [] })
    }),
  )
})
