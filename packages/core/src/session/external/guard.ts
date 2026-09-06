export * as SessionEngineGuard from "./guard"

import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../../database/database"
import { SessionTable } from "../sql"
import { SessionSchema } from "../schema"

export class EngineMismatch extends Schema.TaggedErrorClass<EngineMismatch>()("Session.EngineMismatch", {
  sessionID: SessionSchema.ID,
  engine: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export function check(session: { id: SessionSchema.ID; engine?: string }, operation: string) {
  if (session.engine === undefined || session.engine === "opencode") return Effect.void
  return Effect.fail(
    new EngineMismatch({
      sessionID: session.id,
      engine: session.engine,
      operation,
      message: `OpenCode ${operation} cannot operate on a ${session.engine} Session`,
    }),
  )
}

/** Missing Sessions retain the caller's existing not-found behavior. Never infer an engine from a model. */
export const requireOpenCode = Effect.fn("SessionEngineGuard.requireOpenCode")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  operation: string,
) {
  const row = yield* db
    .select({ id: SessionTable.id, engine: SessionTable.engine })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (row) yield* check(row, operation)
})
