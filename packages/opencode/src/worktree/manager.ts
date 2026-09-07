import { StorageDirectory } from "@opencode-ai/core/storage-directory"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { and, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { lstat, readdir } from "node:fs/promises"
import path from "path"
import { Git } from "@/git"
import { WorktreeArchive } from "./archive"
import { WorktreeLifecycle } from "./lifecycle"

export const Session = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  title: Schema.String,
  archived: Schema.Boolean,
})
export type Session = Schema.Schema.Type<typeof Session>

export const Usage = Schema.Struct({
  ownerIDs: Schema.Array(Schema.String),
  blocked: Schema.Boolean,
})
export type Usage = Schema.Schema.Type<typeof Usage>

export const Owner = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
  intent: Schema.optional(Schema.Literals(["archive", "restore", "delete"])),
  phase: Schema.Literals(["registered", "resident", "captured", "removed", "restored", "delete-preserve"]),
  lastError: Schema.optional(Schema.String),
})
export type Owner = Schema.Schema.Type<typeof Owner>

export const Entry = Schema.Struct({
  directory: Schema.String,
  branch: Schema.optional(Schema.String),
  primary: Schema.Boolean,
  registered: Schema.Boolean,
  managed: Schema.Boolean,
  canAdopt: Schema.Boolean,
  orphan: Schema.Boolean,
  shared: Schema.Boolean,
  missing: Schema.Boolean,
  sessions: Schema.Array(Session),
  usage: Usage,
  owner: Schema.optional(Owner),
})
export type Entry = Schema.Schema.Type<typeof Entry>

export const IgnoredEntry = Schema.Struct({
  path: Schema.String,
  type: Schema.Literals(["file", "directory", "symlink", "other"]),
  reason: Schema.String,
  bytes: Schema.optional(Schema.Number),
})

export const IgnoredPreview = Schema.Struct({
  mode: Schema.Literals(["local", "all"]),
  preserved: Schema.Array(IgnoredEntry),
  skipped: Schema.Array(IgnoredEntry),
  unsupported: Schema.Array(IgnoredEntry),
})

export const Space = Schema.Struct({
  bytes: Schema.Number,
  files: Schema.Number,
  directories: Schema.Number,
  symlinks: Schema.Number,
  errors: Schema.Number,
})

export const ListResult = Schema.Array(Entry)
export const DetailsResult = Schema.Struct({
  entry: Entry,
  space: Schema.optional(Space),
  ignored: Schema.optional(IgnoredPreview),
})
export const AdoptResult = Entry

export class ManagerFailedError extends Schema.TaggedErrorClass<ManagerFailedError>()("WorktreeManagerFailedError", {
  message: Schema.String,
}) {}

export type ListInput = {
  readonly root: string
  readonly projectID: string
}

export type DetailsInput = ListInput & {
  readonly directory: string
}

export type AdoptInput = DetailsInput & {
  readonly sessionID?: string
}

export interface Interface {
  readonly list: (input: ListInput) => Effect.Effect<Schema.Schema.Type<typeof ListResult>, ManagerFailedError>
  readonly details: (input: DetailsInput) => Effect.Effect<Schema.Schema.Type<typeof DetailsResult>, ManagerFailedError>
  readonly adopt: (input: AdoptInput) => Effect.Effect<Schema.Schema.Type<typeof AdoptResult>, ManagerFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeManager") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const git = yield* Git.Service
    const fs = yield* FSUtil.Service
    const resolveDirectory = (directory: string) =>
      fs.resolve(directory).pipe(Effect.map((value) => StorageDirectory.resolve(value)))
    const lifecycle = yield* WorktreeLifecycle.Service
    const archive = yield* WorktreeArchive.Service

    const failed = (message: string) => new ManagerFailedError({ message })

    const resolveProject = Effect.fnUntraced(function* (input: ListInput) {
      const root = yield* resolveDirectory(input.root)
      if (yield* fs.exists(root).pipe(Effect.mapError((error) => failed(error.message)))) return { ...input, root }
      const owner = yield* lifecycle.getDirectory(root).pipe(Effect.mapError((error) => failed(error.message)))
      if (!owner) return yield* failed("The project directory is missing and has no managed recovery record")
      return { root: owner.root, projectID: owner.projectID }
    })

    const run = Effect.fnUntraced(function* (cwd: string, args: string[]) {
      const result = yield* git.run(args, { cwd })
      if (result.exitCode === 0 && !result.truncated) return result.text()
      const detail = result.stderr.toString("utf8").trim() || result.text().trim() || `exit ${result.exitCode}`
      return yield* failed(`git ${args[0]} failed: ${detail}`)
    })

    const gitEntries = Effect.fnUntraced(function* (root: string) {
      const output = yield* run(root, ["worktree", "list", "--porcelain", "-z"])
      const blocks = output.split("\0").reduce<string[][]>(
        (result, item) => {
          if (item) result.at(-1)!.push(item)
          if (!item && result.at(-1)!.length > 0) result.push([])
          return result
        },
        [[]],
      )
      return yield* Effect.forEach(
        blocks.filter((block) => block.length > 0),
        (block, index) =>
          Effect.gen(function* () {
            const directory = block.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
            if (!directory) return
            const branch = block
              .find((line) => line.startsWith("branch refs/heads/"))
              ?.slice("branch refs/heads/".length)
            return {
              directory: yield* resolveDirectory(directory),
              branch,
              primary: index === 0,
            }
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    const sessions = Effect.fnUntraced(function* (input: ListInput) {
      const rows = yield* db
        .select({
          id: SessionTable.id,
          directory: SessionTable.directory,
          title: SessionTable.title,
          archived: SessionTable.time_archived,
        })
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, ProjectV2.ID.make(input.projectID)), isNull(SessionTable.parent_id)))
        .all()
        .pipe(Effect.orDie)
      return yield* Effect.forEach(
        rows,
        (row) =>
          resolveDirectory(row.directory).pipe(
            Effect.map((directory) => ({
              directory,
              session: { id: row.id, directory, title: row.title, archived: row.archived !== null } satisfies Session,
            })),
          ),
        { concurrency: "unbounded" },
      )
    })

    const list = Effect.fn("WorktreeManager.list")(function* (input: ListInput) {
      const project = yield* resolveProject(input)
      const registered = yield* gitEntries(project.root)
      const root = registered[0]?.directory
      if (!root) return yield* failed("Git did not identify a primary worktree")
      const [owners, linked] = yield* Effect.all([
        lifecycle.list({ root, projectID: project.projectID }).pipe(Effect.mapError((error) => failed(error.message))),
        sessions(project),
      ])
      const directories = [
        ...registered.map((entry) => entry.directory),
        ...owners.map((owner) => owner.directory),
      ].filter((directory, index, items) => items.indexOf(directory) === index)
      return yield* Effect.forEach(
        directories,
        (directory) =>
          Effect.gen(function* () {
            const checkout = registered.find((entry) => entry.directory === directory)
            const owner = owners.find((entry) => entry.directory === directory)
            const related = linked
              .filter((entry) => {
                const owner = directories
                  .filter(
                    (candidate) => entry.directory === candidate || entry.directory.startsWith(candidate + path.sep),
                  )
                  .sort((a, b) => b.length - a.length)[0]
                return owner === directory
              })
              .map((entry) => entry.session)
            const usage = yield* lifecycle.usage(directory).pipe(Effect.mapError((error) => failed(error.message)))
            return {
              directory,
              branch: checkout?.branch ?? owner?.branch,
              primary: checkout?.primary ?? false,
              registered: checkout !== undefined,
              managed: owner !== undefined,
              canAdopt:
                !!checkout?.branch &&
                !checkout.primary &&
                !owner &&
                related.length <= 1 &&
                related.every((session) => session.directory === directory) &&
                !usage.blocked &&
                usage.ownerIDs.length === 0,
              orphan: checkout !== undefined && !checkout.primary && related.length === 0 && !owner?.sessionID,
              shared: related.length > 1,
              missing: !(yield* fs.exists(directory).pipe(Effect.mapError((error) => failed(error.message)))),
              sessions: related,
              usage: { ownerIDs: usage.ownerIDs, blocked: usage.blocked },
              owner: owner
                ? {
                    sessionID: owner.sessionID,
                    intent: owner.intent,
                    phase: owner.phase,
                    lastError: owner.lastError,
                  }
                : undefined,
            } satisfies Entry
          }),
        { concurrency: "unbounded" },
      )
    })

    const space = Effect.fnUntraced(function* (directory: string) {
      const walk = (target: string): Effect.Effect<Schema.Schema.Type<typeof Space>> =>
        Effect.tryPromise(() => lstat(target)).pipe(
          Effect.flatMap((info) => {
            if (info.isSymbolicLink())
              return Effect.succeed({ bytes: Number(info.size), files: 0, directories: 0, symlinks: 1, errors: 0 })
            if (info.isFile())
              return Effect.succeed({ bytes: Number(info.size), files: 1, directories: 0, symlinks: 0, errors: 0 })
            if (!info.isDirectory())
              return Effect.succeed({ bytes: Number(info.size), files: 0, directories: 0, symlinks: 0, errors: 1 })
            return Effect.tryPromise(() => readdir(target)).pipe(
              Effect.flatMap((items) =>
                Effect.forEach(items, (item) => walk(path.join(target, item)), { concurrency: 16 }),
              ),
              Effect.map((items) =>
                items.reduce(
                  (total, item) => ({
                    bytes: total.bytes + item.bytes,
                    files: total.files + item.files,
                    directories: total.directories + item.directories,
                    symlinks: total.symlinks + item.symlinks,
                    errors: total.errors + item.errors,
                  }),
                  { bytes: 0, files: 0, directories: 1, symlinks: 0, errors: 0 },
                ),
              ),
            )
          }),
          Effect.catch(() => Effect.succeed({ bytes: 0, files: 0, directories: 0, symlinks: 0, errors: 1 })),
        )
      return yield* walk(directory)
    })

    const details = Effect.fn("WorktreeManager.details")(function* (input: DetailsInput) {
      const directory = yield* resolveDirectory(input.directory)
      const entry = (yield* list(input)).find((item) => item.directory === directory)
      if (!entry) return yield* failed("worktree directory is not registered by Git or this project lifecycle")
      if (entry.missing) return { entry }
      return {
        entry,
        space: yield* space(directory),
        ignored: entry.branch
          ? yield* archive
              .preview({
                directory,
                branch: entry.branch,
                sessionID: entry.owner?.sessionID ?? "worktree-manager-preview",
              })
              .pipe(Effect.mapError((error) => failed(error.message)))
          : undefined,
      }
    })

    const adopt = Effect.fn("WorktreeManager.adopt")(function* (input: AdoptInput) {
      const project = yield* resolveProject(input)
      const root = project.root
      const directory = yield* resolveDirectory(input.directory)
      const entry = (yield* list(project)).find((item) => item.directory === directory)
      if (!entry?.registered) return yield* failed("only a Git-registered linked worktree can be adopted")
      if (entry.primary) return yield* failed("the primary worktree cannot be adopted")
      if (!entry.branch) return yield* failed("a detached worktree cannot be adopted")
      if (entry.managed) return yield* failed("worktree is already managed")
      if (entry.shared) return yield* failed("worktree is shared by more than one root session")
      if (entry.usage.blocked || entry.usage.ownerIDs.length > 0) return yield* failed("worktree is currently in use")
      const common = yield* Effect.all([
        run(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        run(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      ])
      if ((yield* fs.resolve(common[0].trim())) !== (yield* fs.resolve(common[1].trim()))) {
        return yield* failed("worktree belongs to a different Git repository")
      }
      const selected = entry.sessions[0]
      if (selected && selected.directory !== directory)
        return yield* failed("Only a task at the worktree root can own its lifecycle")
      if (input.sessionID && selected?.id !== input.sessionID) {
        return yield* failed("session is not the unique root session for this worktree")
      }
      const sessionID = input.sessionID ?? selected?.id
      yield* lifecycle
        .register({
          directory,
          root,
          branch: entry.branch,
          branchOwned: false,
          projectID: project.projectID,
          sessionID,
        })
        .pipe(Effect.mapError((error) => failed(error.message)))
      const adopted = (yield* list(project)).find((item) => item.directory === directory)
      if (!adopted) return yield* failed("adopted worktree disappeared from the current Git registry")
      return adopted
    })

    return Service.of({ list, details, adopt })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Git.node, FSUtil.node, Database.node, WorktreeLifecycle.node, WorktreeArchive.node],
})

export * as WorktreeManager from "./manager"
