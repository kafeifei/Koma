import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { RelativePath } from "@opencode-ai/core/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionEngineGuard } from "@opencode-ai/core/session/external/guard"
import { SessionExternal } from "@opencode-ai/core/session/external/index"
import { SessionExternalOwnership } from "@opencode-ai/core/session/external/ownership"
import { SessionExternalBindingTable, SessionExternalDeliveryTable } from "@opencode-ai/core/session/external/sql"
import {
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  MessageTable,
  PartTable,
} from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionExternal.node, SessionExternalOwnership.node, SessionV2.node]),
    [
      [
        ProjectV2.node,
        Layer.mock(ProjectV2.Service, {
          resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
        }),
      ],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const input = {
  runtimeScope: "lab-test",
  requestID: "first-request",
  engine: "codex",
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
  payload: {
    input: [{ type: "text", text: "keep this input" }],
    settings: { model: "test-model", approvalPolicy: "untrusted" },
  },
  delivery: "steer",
} satisfies SessionExternal.CreateInput

describe("SessionExternal", () => {
  it.effect("titles new native tasks from the first prompt line without changing exact retries", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const request = {
        ...input,
        payload: { prompt: { text: "\n  验证 Codex 工具卡片  \nRun shell and edit a file." } },
      }
      const created = yield* external.create(request)
      expect(created.session.title).toBe("验证 Codex 工具卡片")
      const sessionID = created.session.id
      yield* external.claimBinding({ sessionID, generation: "host:1" })
      yield* external.bind({ sessionID, generation: "host:1", nativeThreadID: "native" })
      const title = yield* external.syncTitle({
        sessionID,
        runtimeScope: input.runtimeScope,
        nativeThreadID: "native",
        title: "Native title",
      })
      expect(title).toBe("Native title")
      expect((yield* external.create(request)).session.title).toBe("Native title")
    }),
  )

  it.effect("preserves manually renamed titles and unrelated Session state", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const database = yield* Database.Service
      const created = yield* external.create({ ...input, payload: { prompt: { text: "Initial title" } } })
      const sessionID = created.session.id
      yield* external.claimBinding({ sessionID, generation: "host:1" })
      yield* external.bind({ sessionID, generation: "host:1", nativeThreadID: "native" })
      const key = { sessionID, runtimeScope: input.runtimeScope, nativeThreadID: "native" }
      const mismatched = yield* external
        .syncTitle({ ...key, nativeThreadID: "other", title: "Wrong title" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(mismatched) && Cause.hasFails(mismatched.cause)).toBe(true)

      yield* database.db
        .update(SessionTable)
        .set({
          cost: 4.2,
          tokens_input: 18,
          time_archived: 42,
          metadata: { retained: true },
          parent_id: sessionID,
          share_url: "https://example.test/shared",
          permission_mode: "full",
          permission: [{ permission: "shell", pattern: "*", action: "ask" }],
          summary_additions: 2,
          summary_deletions: 1,
          summary_files: 1,
          revert: {
            messageID: SessionMessage.ID.make("msg_preserved"),
            partID: "prt_preserved",
            files: [
              {
                path: RelativePath.make("sample.txt"),
                status: "modified",
                additions: 1,
                deletions: 1,
                patch: "retained patch",
              },
            ],
          },
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
      const before = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
      expect(yield* external.syncTitle({ ...key, title: "Native title" })).toBe("Native title")
      const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
      if (!before || !row) throw new Error("Expected retained Session row")
      expect(row).toEqual({ ...before, title: "Native title" })
      // No process-local provenance is available after restart.
      expect(yield* external.syncTitle({ ...key, title: "Restart title" })).toBeUndefined()
      expect(yield* external.syncTitle({ ...key, title: "Second native title", previousTitle: "Native title" })).toBe(
        "Second native title",
      )
      yield* database.db
        .update(SessionTable)
        .set({ title: "My manual title" })
        .where(eq(SessionTable.id, sessionID))
        .run()
      expect(
        yield* external.syncTitle({ ...key, title: "Third native title", previousTitle: "Second native title" }),
      ).toBeUndefined()
      expect((yield* external.get(sessionID)).session.title).toBe("My manual title")
      const events = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
      expect(
        events.filter(
          (event) =>
            event.type ===
            EventV2.versionedType(SessionV1.Event.Updated.type, SessionV1.Event.Updated.durable!.version),
        ),
      ).toHaveLength(2)
    }),
  )

  it.effect("repairs legacy default titles from their durable first prompt", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const database = yield* Database.Service
      const created = yield* external.create({ ...input, payload: { prompt: { text: "Recovered first line\nrest" } } })
      const sessionID = created.session.id
      yield* external.claimBinding({ sessionID, generation: "host:1" })
      yield* external.bind({ sessionID, generation: "host:1", nativeThreadID: "native" })
      yield* database.db
        .update(SessionTable)
        .set({ title: "New session - 2026-09-07T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
      expect(yield* external.syncTitle({ sessionID, runtimeScope: input.runtimeScope, nativeThreadID: "native" })).toBe(
        "Recovered first line",
      )
    }),
  )

  it.effect("durably fences native execution until its owner confirms all tools finished", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const ownership = yield* SessionExternalOwnership.Service
      const created = yield* external.create(input)
      const sessionID = created.session.id
      yield* external.claimBinding({ sessionID, generation: "host:1" })
      yield* external.bind({ sessionID, generation: "host:1", nativeThreadID: "native" })
      expect((yield* external.get(sessionID)).binding.executionPending).toBe(false)
      yield* ownership.beginGeneration(input.runtimeScope, "host:1")
      yield* ownership.confirmIdle({ sessionID, runtimeScope: input.runtimeScope, generation: "host:1" })
      expect(yield* ownership.isIdle(sessionID)).toBe(true)
      yield* external.claim({ sessionID, requestID: input.requestID, generation: "host:1" })
      expect((yield* external.get(sessionID)).binding.executionPending).toBe(true)
      expect(yield* ownership.isIdle(sessionID)).toBe(false)
      yield* external.recover(input.runtimeScope)
      expect((yield* external.get(sessionID)).binding.executionPending).toBe(true)
      yield* external.setExecutionPending(sessionID, false)
      expect(yield* ownership.isIdle(sessionID)).toBe(true)
    }),
  )

  it.effect("reconciles a late native creation acknowledgement only for its original scope and attempt", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const created = yield* external.create(input)
      const key = {
        sessionID: created.session.id,
        runtimeScope: input.runtimeScope,
        generation: "old-host:1",
        nativeThreadID: "native-confirmed",
      }
      yield* external.claimBinding(key)
      yield* external.recover(input.runtimeScope)
      expect((yield* Effect.flip(external.reconcileBinding({ ...key, generation: "new-host:1" })))._tag).toBe(
        "SessionExternal.Conflict",
      )
      expect((yield* Effect.flip(external.reconcileBinding({ ...key, runtimeScope: "wrong-home" })))._tag).toBe(
        "SessionExternal.Conflict",
      )
      expect((yield* external.reconcileBinding(key)).state).toBe("bound")
      expect((yield* Effect.flip(external.reconcileBinding({ ...key, nativeThreadID: "different" })))._tag).toBe(
        "SessionExternal.Conflict",
      )
    }),
  )

  it.effect("adopts native children once without admitting a synthetic user input", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const database = yield* Database.Service
      const parent = yield* external.create(input)
      const childInput = {
        parentID: parent.session.id,
        runtimeScope: input.runtimeScope,
        nativeThreadID: "native-child",
        location: input.location,
        title: "native child",
      }
      const children = yield* Effect.all(
        Array.from({ length: 6 }, () => external.adoptChild(childInput)),
        { concurrency: "unbounded" },
      )
      expect(new Set(children.map((child) => child.session.id)).size).toBe(1)
      const child = children[0]!
      expect(child.session).toMatchObject({ engine: "codex", parentID: parent.session.id })
      expect(child.binding).toMatchObject({ state: "bound", nativeThreadID: "native-child" })
      expect(yield* external.deliveries(child.session.id)).toEqual([])
      expect(yield* database.db.select().from(SessionTable).all()).toHaveLength(2)
      expect(yield* database.db.select().from(SessionExternalDeliveryTable).all()).toHaveLength(1)
      expect(yield* database.db.select().from(MessageTable).all()).toHaveLength(0)
      expect(yield* database.db.select().from(SessionMessageTable).all()).toHaveLength(0)
      const other = yield* external.create({ ...input, requestID: "other-parent" })
      expect((yield* Effect.flip(external.adoptChild({ ...childInput, parentID: other.session.id })))._tag).toBe(
        "SessionExternal.Conflict",
      )
      expect((yield* external.get(child.session.id)).session.parentID).toBe(parent.session.id)
      expect(
        (yield* Effect.flip(
          external.adoptChild({
            ...childInput,
            nativeThreadID: "other-child",
            location: Location.Ref.make({ directory: AbsolutePath.make("/other-project") }),
          }),
        ))._tag,
      ).toBe("SessionExternal.Conflict")
    }),
  )

  it.effect("atomically deduplicates concurrent first sends before a Session ID exists", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const database = yield* Database.Service
      const created = yield* Effect.all(
        Array.from({ length: 8 }, () => external.create(input)),
        { concurrency: "unbounded" },
      )
      expect(new Set(created.map((item) => item.session.id)).size).toBe(1)
      expect(created[0]?.session.engine).toBe("codex")
      expect(created[0]?.delivery.payload).toEqual(input.payload)
      expect(yield* database.db.select().from(SessionTable).all()).toHaveLength(1)
      expect(yield* database.db.select().from(SessionExternalBindingTable).all()).toHaveLength(1)
      expect(yield* database.db.select().from(SessionExternalDeliveryTable).all()).toHaveLength(1)
      expect(yield* database.db.select().from(EventTable).all()).toHaveLength(1)
    }),
  )

  it.effect("conflicts on changed creation parameters while scopes and JSON key order remain distinct", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const created = yield* external.create(input)
      const same = yield* external.create({
        ...input,
        payload: { settings: input.payload.settings, input: input.payload.input },
      })
      expect(same.session.id).toBe(created.session.id)
      for (const changed of [
        { ...input, title: "different title" },
        { ...input, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { ...input, payload: { ...input.payload, settings: { model: "other" } } },
      ]) {
        expect((yield* Effect.flip(external.create(changed)))._tag).toBe("SessionExternal.Conflict")
      }
      expect((yield* external.create({ ...input, runtimeScope: "other-home" })).session.id).not.toBe(created.session.id)
    }),
  )

  it.effect("rolls back Session, Created event and receipt when the last binding write fails", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const database = yield* Database.Service
      yield* database.db.run(
        sql`CREATE TRIGGER reject_test_binding BEFORE INSERT ON session_external_binding BEGIN SELECT RAISE(ABORT, 'test binding failure'); END`,
      )
      expect(Exit.isFailure(yield* Effect.exit(external.create(input)))).toBe(true)
      expect(yield* database.db.select().from(SessionTable).all()).toHaveLength(0)
      expect(yield* database.db.select().from(SessionExternalDeliveryTable).all()).toHaveLength(0)
      expect(yield* database.db.select().from(EventTable).all()).toHaveLength(0)
    }),
  )

  it.effect("keeps engine immutable when legacy Updated events omit or replace it", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const events = yield* EventV2.Service
      const created = yield* external.create(input)
      for (const engine of [undefined, "opencode"] as const) {
        yield* events.publish(SessionV1.Event.Updated, {
          sessionID: created.session.id,
          info: SessionV1.SessionInfo.make({
            id: created.session.id,
            engine,
            projectID: created.session.projectID,
            directory: created.session.location.directory,
            slug: "legacy",
            title: "renamed",
            version: "test",
            time: { created: 1, updated: 2 },
          }),
        })
        expect((yield* external.get(created.session.id)).session.engine).toBe("codex")
      }
    }),
  )

  it.effect("claims native binding and input once and fences unknown submissions across recovery", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const created = yield* external.create(input)
      const sessionID = created.session.id
      const bindingClaims = yield* Effect.all(
        Array.from({ length: 4 }, () => external.claimBinding({ sessionID, generation: "host-a:1" })),
        { concurrency: "unbounded" },
      )
      expect(bindingClaims.filter(Boolean)).toHaveLength(1)
      yield* external.bind({ sessionID, generation: "host-a:1", nativeThreadID: "native-1" })
      const claims = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          external.claim({ sessionID, requestID: input.requestID, generation: "host-a:1" }),
        ),
        { concurrency: "unbounded" },
      )
      expect(claims.filter(Boolean)).toHaveLength(1)
      yield* external.recover(input.runtimeScope)
      expect((yield* external.getDelivery({ sessionID, requestID: input.requestID }))?.state).toBe("unknown")
      expect(yield* external.claim({ sessionID, requestID: input.requestID, generation: "host-b:1" })).toBeUndefined()
      expect(
        (yield* Effect.flip(
          external.settle({ sessionID, requestID: input.requestID, generation: "host-b:1", state: "accepted" }),
        ))._tag,
      ).toBe("SessionExternal.Conflict")
      const verified = yield* external.settle({
        sessionID,
        requestID: input.requestID,
        generation: "host-a:1",
        state: "accepted",
        nativeTurnID: "turn-1",
      })
      expect(verified.payload).toEqual(input.payload)
      expect(verified.nativeTurnID).toBe("turn-1")
      expect(
        (yield* Effect.flip(
          external.settle({ sessionID, requestID: input.requestID, generation: "host-a:1", state: "rejected" }),
        ))._tag,
      ).toBe("SessionExternal.Conflict")
    }),
  )

  it.effect("preserves payloads while paused queues and unresolved thread creation cannot claim work", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const created = yield* external.create(input)
      const sessionID = created.session.id
      yield* external.claimBinding({ sessionID, generation: "host:1" })
      yield* external.markBindingUnknown({ sessionID, generation: "host:1" })
      expect(yield* external.claimBinding({ sessionID, generation: "host:2" })).toBeUndefined()
      expect(
        (yield* Effect.flip(external.bind({ sessionID, generation: "host:1", nativeThreadID: "guessed" })))._tag,
      ).toBe("SessionExternal.Conflict")
      const second = yield* external.create({ ...input, requestID: "second" })
      yield* external.claimBinding({ sessionID: second.session.id, generation: "host:1" })
      yield* external.bind({ sessionID: second.session.id, generation: "host:1", nativeThreadID: "native-2" })
      yield* external.admit({
        sessionID: second.session.id,
        requestID: "queue",
        payload: input.payload,
        delivery: "queue",
      })
      yield* external.setQueuePaused(second.session.id, true)
      expect((yield* external.pending(second.session.id)).map((item) => item.requestID)).toEqual(["second"])
      expect(
        yield* external.claim({ sessionID: second.session.id, requestID: "queue", generation: "host:1" }),
      ).toBeUndefined()
      expect((yield* external.getDelivery({ sessionID: second.session.id, requestID: "queue" }))?.payload).toEqual(
        input.payload,
      )
    }),
  )

  it.effect("uniquely binds native IDs within a runtime home and never changes an established binding", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const first = yield* external.create(input)
      const second = yield* external.create({ ...input, requestID: "second" })
      for (const item of [first, second])
        yield* external.claimBinding({ sessionID: item.session.id, generation: "host:1" })
      yield* external.bind({ sessionID: first.session.id, generation: "host:1", nativeThreadID: "same-native" })
      expect(
        (yield* Effect.flip(
          external.bind({ sessionID: second.session.id, generation: "host:1", nativeThreadID: "same-native" }),
        ))._tag,
      ).toBe("SessionExternal.Conflict")
      expect(
        (yield* Effect.flip(
          external.bind({ sessionID: first.session.id, generation: "host:1", nativeThreadID: "different-native" }),
        ))._tag,
      ).toBe("SessionExternal.Conflict")
    }),
  )

  it.effect("rejects OpenCode admission and continuation without adding execution history", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const created = yield* external.create(input)
      const mismatch = yield* Effect.flip(SessionEngineGuard.requireOpenCode(database.db, created.session.id, "test"))
      expect(mismatch._tag).toBe("Session.EngineMismatch")
      const operations: Effect.Effect<unknown, unknown>[] = [
        sessions.prompt({ sessionID: created.session.id, prompt: { text: "must not execute" } }),
        sessions.resume(created.session.id),
        sessions.interrupt(created.session.id),
        sessions.setPermissionMode({ sessionID: created.session.id, permissionMode: "full" }),
      ]
      for (const operation of operations) {
        const exit = yield* Effect.exit(operation)
        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("cannot operate on a codex Session")
      }
      expect(yield* database.db.select().from(SessionInputTable).all()).toHaveLength(0)
      expect(yield* database.db.select().from(SessionMessageTable).all()).toHaveLength(0)
      expect(yield* database.db.select().from(MessageTable).all()).toHaveLength(0)
      expect(yield* database.db.select().from(PartTable).all()).toHaveLength(0)
    }),
  )

  it.effect("updates observed activity monotonically", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const database = yield* Database.Service
      const created = yield* external.create(input)
      const time = Date.now() + 1000
      yield* external.touch(created.session.id, time)
      yield* external.touch(created.session.id, time - 100)
      expect(
        (yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, created.session.id)).get())
          ?.time_updated,
      ).toBe(time)
    }),
  )

  it.effect("preserves ordered receipts and frozen input settings when current settings change", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const created = yield* external.create({ ...input, settings: { model: "first-model" } })
      yield* external.admit({
        sessionID: created.session.id,
        requestID: "z",
        payload: input.payload,
        delivery: "queue",
      })
      yield* external.admit({
        sessionID: created.session.id,
        requestID: "a",
        payload: input.payload,
        delivery: "queue",
      })
      yield* external.setSettings(created.session.id, { model: "next-model", effort: "high" })
      expect((yield* external.get(created.session.id)).binding.settings).toEqual({
        model: "next-model",
        effort: "high",
      })
      expect((yield* external.deliveries(created.session.id)).map((row) => row.requestID)).toEqual([
        input.requestID,
        "z",
        "a",
      ])
      expect(
        (yield* external.getDelivery({ sessionID: created.session.id, requestID: input.requestID }))?.payload,
      ).toEqual(input.payload)
    }),
  )

  it.effect("atomically fences pending withdrawal against the native send claim", () =>
    Effect.gen(function* () {
      const external = yield* SessionExternal.Service
      const created = yield* external.create(input)
      const key = { sessionID: created.session.id, requestID: input.requestID }
      yield* external.claimBinding({ sessionID: key.sessionID, generation: "host:1" })
      yield* external.bind({ sessionID: key.sessionID, generation: "host:1", nativeThreadID: "native" })
      const results = yield* Effect.all(
        [Effect.exit(external.withdraw(key)), Effect.exit(external.claim({ ...key, generation: "host:1" }))],
        { concurrency: "unbounded" },
      )
      const receipt = yield* external.getDelivery(key)
      expect(receipt).toBeDefined()
      expect(["sending", "withdrawn"]).toContain(receipt!.state)
      if (receipt?.state === "sending") expect(Exit.isFailure(results[0])).toBe(true)
      if (receipt?.state === "withdrawn") {
        expect(results[1]).toEqual(Exit.succeed(undefined))
        expect((yield* external.withdraw(key)).state).toBe("withdrawn")
      }
      expect((yield* external.deliveries(key.sessionID))[0]?.payload).toEqual(input.payload)
    }),
  )
})

describe("SessionExternalOwnership", () => {
  it.effect("defaults unknown and rejects idle observations from replaced connections", () =>
    Effect.gen(function* () {
      const ownership = yield* SessionExternalOwnership.Service
      const sessionID = SessionV2.ID.create()
      expect(yield* ownership.isIdle(sessionID)).toBe(false)
      yield* ownership.beginGeneration("home", "host-a:1")
      expect(yield* ownership.confirmIdle({ runtimeScope: "home", generation: "host-a:1", sessionID })).toBe(true)
      expect(yield* ownership.isIdle(sessionID)).toBe(true)
      yield* ownership.beginGeneration("home", "host-b:1")
      expect(yield* ownership.isIdle(sessionID)).toBe(false)
      expect(yield* ownership.confirmIdle({ runtimeScope: "home", generation: "host-a:1", sessionID })).toBe(false)
      yield* ownership.confirmIdle({ runtimeScope: "home", generation: "host-b:1", sessionID })
      yield* ownership.invalidateScope("home")
      expect(yield* ownership.confirmIdle({ runtimeScope: "home", generation: "host-b:1", sessionID })).toBe(false)
    }),
  )
})
