import { describe, expect } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionExternalBindingTable, SessionExternalDeliveryTable } from "@opencode-ai/core/session/external/sql"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { WorktreeArchive } from "../../src/worktree/archive"
import { WorktreeLifecycle } from "../../src/worktree/lifecycle"
import { InstanceDisposal } from "../../src/project/instance-disposal"
import { Storage } from "../../src/storage/storage"
import { Git } from "../../src/git"
import { SessionExternalOwnership } from "@opencode-ai/core/session/external/ownership"
import { LabShutdownState } from "../../src/lab/shutdown-state"
import { SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const state = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)
const it = testEffect(
  Layer.mergeAll(
    state,
    NodeServices.layer,
    LayerNode.compile(
      LayerNode.group([
        WorktreeLifecycle.node,
        WorktreeArchive.node,
        InstanceDisposal.node,
        Storage.node,
        Database.node,
        Git.node,
        SessionExternalOwnership.node,
      ]),
    ),
  ),
)

const execution = {
  active: Effect.succeed(new Set()),
} satisfies Pick<SessionExecution.Interface, "active">

describe("lab shutdown state", () => {
  it.live("sees durable input, Codex pending state, and a child lease, then returns idle after cleanup", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const projectID = ProjectV2.ID.make(`shutdown-${crypto.randomUUID()}`)
      const sessionID = SessionID.create()
      const { db } = yield* Database.Service
      const now = Date.now()
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: AbsolutePath.make(directory),
          sandboxes: [],
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          parent_id: SessionID.create(),
          slug: sessionID,
          directory,
          title: "shutdown test",
          version: "test",
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      const lifecycle = yield* WorktreeLifecycle.Service
      const input = { database: { db }, execution, lifecycle }
      expect(yield* LabShutdownState.read(input)).toBe(false)

      yield* lifecycle.acquire({ directory, sessionID })
      expect(yield* LabShutdownState.read(input)).toBe(true)
      yield* lifecycle.release({ directory, sessionID })
      expect(yield* LabShutdownState.read(input)).toBe(false)

      yield* db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          prompt: { text: "queued" },
          delivery: "queue",
          admitted_seq: 1,
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* LabShutdownState.read(input)).toBe(true)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)

      yield* db
        .insert(SessionExternalBindingTable)
        .values({
          session_id: sessionID,
          runtime_scope: "shutdown-test",
          state: "pending",
          queue_paused: true,
          execution_pending: false,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      // A stopped, never-started native binding has no execution to interrupt.
      expect(yield* LabShutdownState.read(input)).toBe(false)
      for (const state of ["creating", "unknown"] as const) {
        yield* db
          .update(SessionExternalBindingTable)
          .set({ state })
          .where(eq(SessionExternalBindingTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* LabShutdownState.read(input)).toBe(true)
      }
      yield* db
        .update(SessionExternalBindingTable)
        .set({ state: "bound", queue_paused: false, execution_pending: true })
        .where(eq(SessionExternalBindingTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* LabShutdownState.read(input)).toBe(true)
      yield* db
        .update(SessionExternalBindingTable)
        .set({ execution_pending: false })
        .where(eq(SessionExternalBindingTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionExternalDeliveryTable)
        .values({
          session_id: sessionID,
          request_id: "queued-delivery",
          sequence: 1,
          fingerprint: "test",
          payload: {},
          delivery: "queue",
          state: "pending",
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* LabShutdownState.read(input)).toBe(true)
      yield* db
        .delete(SessionExternalDeliveryTable)
        .where(eq(SessionExternalDeliveryTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .delete(SessionExternalBindingTable)
        .where(eq(SessionExternalBindingTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* LabShutdownState.read(input)).toBe(false)
    }),
  )
})
