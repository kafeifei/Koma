export * as ProjectDirectories from "./directories"

import { and, asc, desc, eq, isNotNull, isNull, ne, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { AbsolutePath, optional } from "../schema"
import { ProjectSchema } from "./schema"
import { ProjectDirectoryTable } from "./sql"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { StorageDirectory } from "../storage-directory"

export interface Directory {
  readonly directory: AbsolutePath
  readonly strategy?: string
}

export const CreateInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
  strategy: Schema.optional(Schema.String),
  behavior: Schema.Literals(["ignore", "replace"]).pipe(Schema.optional),
})
export type CreateInput = typeof CreateInput.Type

export const RemoveInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
})
export type RemoveInput = typeof RemoveInput.Type

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export const ListInput = Schema.Struct({
  projectID: ProjectSchema.ID,
}).annotate({ identifier: "Project.DirectoriesInput" })
export type ListInput = typeof ListInput.Type

export const ListOutput = Schema.Array(
  Schema.Struct({
    directory: AbsolutePath,
    strategy: optional(Schema.String),
  }),
).annotate({ identifier: "Project.Directories" })
export type ListOutput = typeof ListOutput.Type

export interface Interface {
  readonly list: (projectID: ProjectSchema.ID) => Effect.Effect<ReadonlyArray<Directory>>
  readonly get: (input: {
    projectID: ProjectSchema.ID
    directory: AbsolutePath
  }) => Effect.Effect<Directory | undefined>
  readonly contains: (input: { projectID: ProjectSchema.ID; directory: AbsolutePath }) => Effect.Effect<boolean>
  readonly create: (input: CreateInput, tx?: Transaction) => Effect.Effect<boolean>
  readonly remove: (input: RemoveInput, tx?: Transaction) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectDirectories") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const canonical = (directory: AbsolutePath) => AbsolutePath.make(StorageDirectory.resolve(directory))
    const reconcileWith = Effect.fnUntraced(function* (
      projectID: ProjectSchema.ID,
      client: DatabaseClient | Transaction,
    ) {
      const rows = yield* client
        .select()
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, projectID))
        .all()
        .pipe(Effect.orDie)
      const changed = yield* Effect.forEach(
        Map.groupBy(rows, (row) => canonical(row.directory)),
        ([directory, entries]) =>
          Effect.gen(function* () {
            if (entries.every((row) => row.directory === directory)) return false
            const strategies = [...new Set(entries.flatMap((row) => (row.strategy === null ? [] : [row.strategy])))]
            const types = [...new Set(entries.flatMap((row) => (row.type === null ? [] : [row.type])))]
            // Conflicting metadata may represent distinct ownership. Keep both records for inspection.
            if (strategies.length > 1 || types.length > 1) {
              yield* Effect.logWarning("conflicting migrated project directory records", { projectID, directory })
              return false
            }
            const retained = entries.find((row) => row.directory === directory) ?? entries[0]!
            yield* Effect.forEach(
              entries.filter((row) => row !== retained),
              (row) =>
                client
                  .delete(ProjectDirectoryTable)
                  .where(
                    and(
                      eq(ProjectDirectoryTable.project_id, projectID),
                      eq(ProjectDirectoryTable.directory, row.directory),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie),
            )
            yield* client
              .update(ProjectDirectoryTable)
              .set({
                directory,
                strategy: strategies[0] ?? null,
                type: types[0] ?? null,
              })
              .where(
                and(
                  eq(ProjectDirectoryTable.project_id, projectID),
                  eq(ProjectDirectoryTable.directory, retained.directory),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            return true
          }),
      )
      return changed.some(Boolean)
    })
    const reconcile = (projectID: ProjectSchema.ID, tx?: Transaction) => {
      if (!process.env.OPENCODE_HOME?.trim()) return Effect.succeed(false)
      return tx
        ? reconcileWith(projectID, tx)
        : db.transaction((client) => reconcileWith(projectID, client)).pipe(Effect.orDie)
    }

    const create = Effect.fn("ProjectDirectories.create")(function* (input: CreateInput, tx?: Transaction) {
      const repaired = yield* reconcile(input.projectID, tx)
      const insert = (tx ?? db)
        .insert(ProjectDirectoryTable)
        .values({ project_id: input.projectID, directory: canonical(input.directory), strategy: input.strategy })
      const query =
        input.behavior === "replace"
          ? insert.onConflictDoUpdate({
              target: [ProjectDirectoryTable.project_id, ProjectDirectoryTable.directory],
              set: { strategy: input.strategy ?? null },
              setWhere: input.strategy
                ? or(isNull(ProjectDirectoryTable.strategy), ne(ProjectDirectoryTable.strategy, input.strategy))
                : isNotNull(ProjectDirectoryTable.strategy),
            })
          : insert.onConflictDoNothing()
      return (
        (yield* query.returning({ directory: ProjectDirectoryTable.directory }).get().pipe(Effect.orDie)) !==
          undefined || repaired
      )
    })

    const remove = Effect.fn("ProjectDirectories.remove")(function* (input: RemoveInput, tx?: Transaction) {
      yield* reconcile(input.projectID, tx)
      return (
        (yield* (tx ?? db)
          .delete(ProjectDirectoryTable)
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, canonical(input.directory)),
            ),
          )
          .returning({ directory: ProjectDirectoryTable.directory })
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const list = Effect.fn("ProjectDirectories.list")(function* (projectID: ProjectSchema.ID) {
      yield* reconcile(projectID)
      const rows = yield* db
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, projectID))
        .orderBy(desc(ProjectDirectoryTable.time_created), asc(ProjectDirectoryTable.directory))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ directory: row.directory, strategy: row.strategy ?? undefined }))
    })

    const contains = Effect.fn("ProjectDirectories.contains")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      yield* reconcile(input.projectID)
      return (
        (yield* db
          .select({ directory: ProjectDirectoryTable.directory })
          .from(ProjectDirectoryTable)
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, canonical(input.directory)),
            ),
          )
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const get = Effect.fn("ProjectDirectories.get")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      yield* reconcile(input.projectID)
      const row = yield* db
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(
          and(
            eq(ProjectDirectoryTable.project_id, input.projectID),
            eq(ProjectDirectoryTable.directory, canonical(input.directory)),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? { directory: row.directory, strategy: row.strategy ?? undefined } : undefined
    })

    return Service.of({
      list,
      get,
      contains,
      create,
      remove,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })
