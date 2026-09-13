export * as ProjectV2 from "./project"
export * as Project from "./project"

import { Context, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "path"
import { AbsolutePath } from "./schema"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { makeGlobalNode } from "./effect/app-node"
import { ProjectDirectories } from "./project/directories"
import { ProjectSchema } from "./project/schema"
import { StorageDirectory } from "./storage-directory"

export const ID = ProjectSchema.ID
export type ID = ProjectSchema.ID

export const Vcs = ProjectSchema.Vcs
export type Vcs = ProjectSchema.Vcs

export class Info extends Schema.Class<Info>("Project.Info")({
  id: ID,
}) {}

export const DirectoriesInput = ProjectDirectories.ListInput
export type DirectoriesInput = typeof DirectoriesInput.Type

export const Directories = ProjectDirectories.ListOutput
export type Directories = typeof Directories.Type

export interface Resolved {
  readonly id: ID
  readonly directory: AbsolutePath
  readonly vcs?: Vcs
}

export interface Interface {
  readonly directories: (input: DirectoriesInput) => Effect.Effect<Directories>
  /** Resolves a project, durably allocating its identity before returning a new ID. */
  readonly resolve: (input: AbsolutePath) => Effect.Effect<Resolved>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectV2") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const projectDirectories = yield* ProjectDirectories.Service

    const directories = Effect.fn("Project.directories")(function* (input: DirectoriesInput) {
      return yield* projectDirectories.list(input.projectID)
    })

    const readIdentity = Effect.fnUntraced(function* (file: string) {
      const value = yield* fs.readFileString(file).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (value === undefined) return undefined
      const id = value.trim()
      if (!id || id === ID.global) return yield* Effect.die(new Error(`Invalid project identity: ${file}`))
      return ID.make(id)
    })

    const identity = Effect.fn("Project.identity")(function* (store: AbsolutePath) {
      // Keep the legacy filename and existing IDs. The common Git directory is
      // shared by linked worktrees and moves with the repository; origin and HEAD
      // are mutable metadata and must never redefine task ownership.
      const file = path.join(store, "opencode")
      const existing = yield* readIdentity(file)
      if (existing) return existing

      const id = ID.make(randomUUID())
      const temporary = yield* Effect.acquireRelease(
        Effect.succeed(path.join(store, `opencode-${randomUUID()}.tmp`)),
        (file) => fs.remove(file, { force: true }).pipe(Effect.orDie),
      )
      yield* fs.writeFileString(temporary, id, { flag: "wx" }).pipe(Effect.orDie)
      // Publish a complete file without replacing another process's identity.
      // Direct exclusive writes expose an empty/partial ID to concurrent readers.
      yield* fs.link(temporary, file).pipe(
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
        Effect.orDie,
      )
      const persisted = yield* readIdentity(file)
      if (!persisted) return yield* Effect.die(new Error(`Project identity disappeared: ${file}`))
      return persisted
    }, Effect.scoped)

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const repo = yield* git.repo.discover(input)
      if (!repo) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }

      const id = yield* identity(repo.commonDirectory)
      return {
        id,
        directory: AbsolutePath.make(StorageDirectory.resolve(repo.worktree)),
        vcs: { type: "git" as const, store: repo.commonDirectory },
      }
    })

    return Service.of({ directories, resolve })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, ProjectDirectories.node],
})
