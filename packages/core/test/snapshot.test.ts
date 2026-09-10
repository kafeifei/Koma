import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("Snapshot", () => {
  testEffect(Layer.empty).live("captures and restores Location-scoped changes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "tracked.txt"), "one\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          const layer = snapshotLayer(tmp.path, location)
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(location, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(location, "added.txt"), "added\n")
              await fs.writeFile(path.join(project, "outside.txt"), "changed outside\n")
            })
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return

            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make("scope/added.txt"),
              RelativePath.make("scope/tracked.txt"),
            ])
            const plan = new Map([[RelativePath.make("scope/tracked.txt"), before]])
            const preview = yield* snapshot.preview({ files: plan, context: 1 })
            expect(preview).toHaveLength(1)
            expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(location, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(location, "added.txt"))).toBe("added\n")
            expect(yield* read(path.join(project, "outside.txt"))).toBe("changed outside\n")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("treats capture outside Git as unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, tmp.path))),
          ).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("isolates snapshot indexes by canonical Git worktree", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const linked = path.join(tmp.path, "linked")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "main\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await $`git worktree add --detach ${linked} HEAD`.cwd(project).quiet()
          })

          const capture = (directory: string) =>
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, directory)))
          expect(yield* capture(project)).toBeDefined()
          expect(yield* capture(linked)).toBeDefined()

          const projectID = yield* Effect.gen(function* () {
            return (yield* Location.Service).project.id
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
            ),
          )
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(project)))),
          ).toBeDefined()
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(linked)))),
          ).toBeDefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("reuses snapshots after a managed worktree moves to unified storage", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "home")
          const legacyRoot = path.join(tmp.path, "legacy")
          const data = path.join(legacyRoot, "backend/data/opencode")
          const repository = path.join(data, "repos/project")
          const logical = path.join(data, "worktree/project/task")
          yield* Effect.promise(async () => {
            await fs.mkdir(repository, { recursive: true })
            await fs.writeFile(path.join(repository, "tracked.txt"), "one\n")
            await $`git init`.cwd(repository).quiet()
            await $`git config core.fsmonitor false`.cwd(repository).quiet()
            await $`git config commit.gpgsign false`.cwd(repository).quiet()
            await $`git config user.email test@opencode.test`.cwd(repository).quiet()
            await $`git config user.name Test`.cwd(repository).quiet()
            await $`git add .`.cwd(repository).quiet()
            await $`git commit -m initial`.cwd(repository).quiet()
            await fs.mkdir(path.dirname(logical), { recursive: true })
            await $`git worktree add --detach ${logical} HEAD`.cwd(repository).quiet()
          })

          const before = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            return yield* snapshot.capture()
          }).pipe(Effect.provide(snapshotLayer(data, logical)))
          expect(before).toBeDefined()
          if (!before) return

          const [projectID] = yield* Effect.promise(() => fs.readdir(path.join(data, "snapshot")))
          expect(projectID).toBeDefined()
          if (!projectID) return
          const oldRepository = path.join(data, "snapshot", projectID, Hash.fast(logical))
          expect(yield* exists(path.join(oldRepository, "HEAD"))).toBe(true)

          yield* Effect.sync(() => {
            StorageMigration.prepareUnifiedHome({ root, legacyRoot, acquireLock: () => true })
          })
          const physical = yield* Effect.promise(() => fs.realpath(path.join(root, "worktrees/project/task")))
          const snapshots = path.join(root, "data/snapshots")
          const migratedRepository = path.join(snapshots, projectID, Hash.fast(logical))
          const physicalRepository = path.join(snapshots, projectID, Hash.fast(physical))
          expect(migratedRepository).not.toBe(physicalRepository)

          yield* Effect.promise(() => fs.writeFile(path.join(physical, "tracked.txt"), "two\n"))
          const reused = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const captured = yield* snapshot.capture()
            expect(captured).toBeDefined()
            if (!captured) return
            expect(yield* snapshot.files({ from: before, to: captured })).toEqual([RelativePath.make("tracked.txt")])
            return captured
          }).pipe(Effect.provide(snapshotLayer(path.join(root, "data"), logical, { root, snapshot: snapshots })))
          expect(reused).toBeDefined()
          if (!reused) return
          expect(yield* exists(path.join(migratedRepository, "HEAD"))).toBe(true)
          expect(yield* exists(physicalRepository)).toBe(false)

          const parked = migratedRepository + ".parked"
          yield* Effect.promise(() => fs.rename(migratedRepository, parked))
          const physicalSnapshot = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            return yield* snapshot.capture()
          }).pipe(Effect.provide(snapshotLayer(path.join(root, "data"), physical, { root, snapshot: snapshots })))
          expect(physicalSnapshot).toBeDefined()
          if (!physicalSnapshot) return
          expect(yield* exists(path.join(physicalRepository, "HEAD"))).toBe(true)
          yield* Effect.promise(() => fs.rename(parked, migratedRepository))

          yield* Effect.promise(() => fs.writeFile(path.join(physical, "tracked.txt"), "three\n"))
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return
            expect(yield* snapshot.files({ from: physicalSnapshot, to: after })).toEqual([
              RelativePath.make("tracked.txt"),
            ])
            const diff = yield* snapshot.diff({ from: before, to: after })
            expect(diff).toHaveLength(1)
            expect(diff[0]?.path).toBe(RelativePath.make("tracked.txt"))
            expect(diff[0]?.patch).toContain("-one")
            expect(diff[0]?.patch).toContain("+three")
          }).pipe(Effect.provide(snapshotLayer(path.join(root, "data"), logical, { root, snapshot: snapshots })))

          expect(yield* read(path.join(physicalRepository, "objects/info/alternates"))).toContain(
            path.join(migratedRepository, "objects"),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("checks out a legacy revert snapshot without removing unrelated files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(project, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(project, "unrelated.txt"), "keep\n")
            })
            yield* snapshot.checkout(before)
            expect(yield* read(path.join(project, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(project, "unrelated.txt"))).toBe("keep\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function snapshotLayer(data: string, directory: string, storage?: { root: string; snapshot: string }) {
  return AppNodeBuilder.build(Snapshot.node, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
    [Global.node, Global.layerWith(storage ?? { data, config: path.join(data, "config") })],
  ])
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replaceAll("\r\n", "\n")))
}

function exists(file: string) {
  return Effect.promise(() =>
    fs.stat(file).then(
      () => true,
      () => false,
    ),
  )
}
