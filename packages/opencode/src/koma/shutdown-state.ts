import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionExternalBindingTable, SessionExternalDeliveryTable } from "@opencode-ai/core/session/external/sql"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionID } from "@/session/schema"
import { WorktreeLifecycle } from "@/worktree/lifecycle"
import { eq, inArray, isNull } from "drizzle-orm"
import { Effect } from "effect"

export * as KomaShutdownState from "./shutdown-state"

/** Read durable and process-local evidence without loading any native runtime. */
export const read = Effect.fn("KomaShutdownState.read")(function* (input: {
  readonly database: Database.Interface
  readonly execution: Pick<SessionExecution.Interface, "active">
  readonly lifecycle: Pick<WorktreeLifecycle.Interface, "leaseOwnerIDs">
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
      // A pending binding can be a stopped task that never started a native thread.
      // Its admitted work is covered by execution_pending and delivery rows below.
      .where(inArray(SessionExternalBindingTable.state, ["creating", "unknown"]))
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
  // Only session-owned leases block shutdown; PTY leases keep a shell alive without any running work.
  const leaseOwners = yield* input.lifecycle.leaseOwnerIDs
  const leasedSession =
    leaseOwners.length > 0 &&
    (yield* input.database.db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(
        inArray(
          SessionTable.id,
          // Non-session owners (pty:*) simply match no row.
          leaseOwners.map((owner) => owner as SessionID),
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)) !== undefined
  return executionActive || leasedSession || pendingInput || pendingBinding || uncertainBinding || pendingDelivery
})
