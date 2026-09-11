import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { SessionExternalBindingTable, SessionExternalDeliveryTable } from "@opencode-ai/core/session/external/sql"
import { Database } from "@opencode-ai/core/database/database"
import { WorktreeLifecycle } from "@/worktree/lifecycle"
import { eq, inArray, isNull } from "drizzle-orm"
import { Effect } from "effect"

export * as LabShutdownState from "./shutdown-state"

/** Read durable and process-local evidence without loading any native runtime. */
export const read = Effect.fn("LabShutdownState.read")(function* (input: {
  readonly database: Database.Interface
  readonly execution: Pick<SessionExecution.Interface, "active">
  readonly lifecycle: WorktreeLifecycle.Interface
}) {
  const executionActive = (yield* input.execution.active).size > 0
  const pendingInput =
    (yield* input.database.db
      .select({ id: SessionInputTable.id })
      .from(SessionInputTable)
      .where(isNull(SessionInputTable.promoted_seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)) !== undefined
  const pendingBinding =
    (yield* input.database.db
      .select({ id: SessionExternalBindingTable.session_id })
      .from(SessionExternalBindingTable)
      .where(eq(SessionExternalBindingTable.execution_pending, true))
      .limit(1)
      .get()
      .pipe(Effect.orDie)) !== undefined
  const uncertainBinding =
    (yield* input.database.db
      .select({ id: SessionExternalBindingTable.session_id })
      .from(SessionExternalBindingTable)
      .where(inArray(SessionExternalBindingTable.state, ["pending", "creating", "unknown"]))
      .limit(1)
      .get()
      .pipe(Effect.orDie)) !== undefined
  const pendingDelivery =
    (yield* input.database.db
      .select({ id: SessionExternalDeliveryTable.request_id })
      .from(SessionExternalDeliveryTable)
      .where(inArray(SessionExternalDeliveryTable.state, ["pending", "sending", "unknown"]))
      .limit(1)
      .get()
      .pipe(Effect.orDie)) !== undefined
  const leasedSession = yield* input.lifecycle.hasActiveLease
  return executionActive || leasedSession || pendingInput || pendingBinding || uncertainBinding || pendingDelivery
})
