import { $ } from "bun"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit } from "effect"
import path from "path"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { WorktreeBranch } from "@/worktree/branch"
import { WorktreeLifecycle } from "@/worktree/lifecycle"
import { provideInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([WorktreeBranch.node, WorktreeLifecycle.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)

describe("worktree branch checkout", () => {
  it.instance(
    "switches the repository checkout when requested from a subdirectory",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const current = yield* divergentBranches(directory, "release")
        const nested = path.join(directory, "nested")
        yield* Effect.promise(() => Bun.write(path.join(nested, "keep.txt"), "untracked\n"))
        const branch = yield* WorktreeBranch.Service

        expect(yield* branch.checkout({ branch: "release" }).pipe(provideInstance(nested))).toEqual({
          branch: "release",
        })
        expect(yield* git(directory, ["branch", "--show-current"])).toBe("release")
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "tracked.txt")).text())).toBe("release\n")
        expect(yield* Effect.promise(() => Bun.file(path.join(nested, "keep.txt")).text())).toBe("untracked\n")

        yield* git(directory, ["checkout", current, "--"])
      }),
    { git: true },
  )

  it.instance(
    "keeps an occupied current branch idempotent and preserves dirty files",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const current = yield* git(directory, ["branch", "--show-current"])
        yield* git(directory, ["branch", "target"])
        yield* Effect.promise(() => Bun.write(path.join(directory, "dirty.txt"), "keep\n"))
        const lifecycle = yield* WorktreeLifecycle.Service
        yield* lifecycle.acquire({ directory, sessionID: "session-running" })
        yield* Effect.addFinalizer(() => lifecycle.release({ directory, sessionID: "session-running" }))

        const branch = yield* WorktreeBranch.Service
        expect(yield* branch.checkout({ branch: current })).toEqual({ branch: current })
        expect(Exit.isFailure(yield* branch.checkout({ branch: "target" }).pipe(Effect.exit))).toBe(true)
        expect(yield* git(directory, ["branch", "--show-current"])).toBe(current)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "dirty.txt")).text())).toBe("keep\n")
      }),
    { git: true },
  )

  it.instance(
    "leaves the branch and dirty content unchanged when checkout conflicts",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const current = yield* divergentBranches(directory, "release")
        yield* Effect.promise(() => Bun.write(path.join(directory, "tracked.txt"), "dirty\n"))

        const branch = yield* WorktreeBranch.Service
        const result = yield* branch.checkout({ branch: "release" }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* git(directory, ["branch", "--show-current"])).toBe(current)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "tracked.txt")).text())).toBe("dirty\n")
      }),
    { git: true },
  )

  it.instance(
    "does not disturb either checkout when another worktree owns the branch",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const current = yield* divergentBranches(directory, "occupied")
        yield* git(directory, ["branch", "linked-target"])
        const linked = `${directory}-linked`
        yield* git(directory, ["worktree", "add", linked, "occupied"])
        yield* Effect.addFinalizer(() => git(directory, ["worktree", "remove", "--force", linked]).pipe(Effect.ignore))
        yield* Effect.promise(() => Bun.write(path.join(directory, "source-keep.txt"), "source\n"))
        yield* Effect.promise(() => Bun.write(path.join(linked, "linked-keep.txt"), "linked\n"))

        const branch = yield* WorktreeBranch.Service
        const result = yield* branch.checkout({ branch: "occupied" }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* git(directory, ["branch", "--show-current"])).toBe(current)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "source-keep.txt")).text())).toBe("source\n")
        expect(yield* Effect.promise(() => Bun.file(path.join(linked, "linked-keep.txt")).text())).toBe("linked\n")

        expect(yield* branch.checkout({ branch: "linked-target" }).pipe(provideInstance(linked))).toEqual({
          branch: "linked-target",
        })
        expect(yield* git(linked, ["branch", "--show-current"])).toBe("linked-target")
        expect(yield* git(directory, ["branch", "--show-current"])).toBe(current)
        expect(yield* Effect.promise(() => Bun.file(path.join(linked, "linked-keep.txt")).text())).toBe("linked\n")
      }),
    { git: true },
  )

  it.instance(
    "rejects special revisions and unknown local branches",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const current = yield* git(directory, ["branch", "--show-current"])
        const branch = yield* WorktreeBranch.Service
        const inputs = ["HEAD", `refs/heads/${current}`, `${current}~1`, `-${current}`, ` ${current}`, "missing"]
        const results = yield* Effect.forEach(inputs, (name) => branch.checkout({ branch: name }).pipe(Effect.exit))

        expect(results.every(Exit.isFailure)).toBe(true)
        expect(yield* git(directory, ["branch", "--show-current"])).toBe(current)
      }),
    { git: true },
  )
})

function divergentBranches(directory: string, branch: string) {
  return Effect.gen(function* () {
    const current = yield* git(directory, ["branch", "--show-current"])
    yield* Effect.promise(() => Bun.write(path.join(directory, "tracked.txt"), "source\n"))
    yield* git(directory, ["add", "tracked.txt"])
    yield* git(directory, ["commit", "-m", "source"])
    yield* git(directory, ["checkout", "-b", branch])
    yield* Effect.promise(() => Bun.write(path.join(directory, "tracked.txt"), `${branch}\n`))
    yield* git(directory, ["commit", "-am", branch])
    yield* git(directory, ["checkout", current, "--"])
    return current
  })
}

function git(directory: string, args: string[]) {
  return Effect.promise(async () => {
    const result = await $`git ${args}`.cwd(directory).quiet().nothrow()
    if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args[0]} failed`)
    return result.stdout.toString().trim()
  })
}
