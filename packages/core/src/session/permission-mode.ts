export * as SessionPermissionMode from "./permission-mode"

import { PermissionMode } from "@opencode-ai/schema/session-permission-mode"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionSchema } from "./schema"
import type { SessionTable } from "./sql"

export function resolveRow(db: Database.Interface["db"], row: typeof SessionTable.$inferSelect) {
  if (row.permission_mode !== null) return Effect.succeed(PermissionMode.make(row.permission_mode))
  if (row.parent_id === null) return Effect.succeed(PermissionMode.make("default"))
  return resolve(db, SessionSchema.ID.make(row.id))
}

export const resolve = Effect.fn("SessionPermissionMode.resolve")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .get<{ permissionMode: string | null }>(
      sql`
      WITH RECURSIVE ancestors(id, parent_id, permission_mode) AS (
        SELECT id, parent_id, permission_mode
        FROM session
        WHERE id = ${sessionID}

        UNION

        SELECT parent.id, parent.parent_id, parent.permission_mode
        FROM session AS parent
        JOIN ancestors AS child ON parent.id = child.parent_id
        WHERE child.permission_mode IS NULL
      )
      SELECT permission_mode AS permissionMode
      FROM ancestors
      WHERE permission_mode IS NOT NULL
      LIMIT 1
    `,
    )
    .pipe(Effect.orDie)
  return Schema.is(PermissionMode)(row?.permissionMode) ? row.permissionMode : PermissionMode.make("default")
})

export const affectedBy = Effect.fn("SessionPermissionMode.affectedBy")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  changedSessionID: SessionSchema.ID,
) {
  const row = yield* db
    .get<{ affected: number }>(
      sql`
      WITH RECURSIVE lineage(id, parent_id, permission_mode) AS (
        SELECT id, parent_id, permission_mode
        FROM session
        WHERE id = ${sessionID}

        UNION

        SELECT parent.id, parent.parent_id, parent.permission_mode
        FROM session AS parent
        JOIN lineage AS child ON parent.id = child.parent_id
        WHERE child.permission_mode IS NULL
      )
      SELECT 1 AS affected
      FROM lineage
      WHERE id = ${changedSessionID}
      LIMIT 1
    `,
    )
    .pipe(Effect.orDie)
  return row !== undefined
})
