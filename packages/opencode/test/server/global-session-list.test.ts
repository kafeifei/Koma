import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Layer } from "effect"
import { Project } from "@/project/project"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([SessionNs.node, SessionProjector.node, Project.node, CrossSpawnSpawner.node, Database.node]),
  ),
)

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

const addText = (sessionID: SessionID, text: string, flags?: { ignored?: boolean; synthetic?: boolean }) =>
  SessionNs.Service.use((session) =>
    Effect.gen(function* () {
      const message = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID: message.id,
        type: "text",
        text,
        ...flags,
      })
    }),
  )

const addReasoning = (sessionID: SessionID, text: string) =>
  SessionNs.Service.use((session) =>
    Effect.gen(function* () {
      const message = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text,
        time: { start: 0 },
      })
    }),
  )

const setUpdated = (sessionID: SessionID, updated: number) =>
  Database.Service.use(({ db }) =>
    db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie),
  )

describe("session.listGlobal", () => {
  it.instance(
    "lists sessions across projects with project metadata",
    () =>
      Effect.gen(function* () {
        const first = yield* TestInstance
        const second = yield* tmpdirScoped({ git: true })

        const firstSession = yield* withSession({ title: "first-session" })
        const secondSession = yield* withSession({ title: "second-session" }).pipe(provideInstance(second))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(firstSession.id)
        expect(ids).toContain(secondSession.id)

        const firstProject = yield* Project.use.get(firstSession.projectID)
        const secondProject = yield* Project.use.get(secondSession.projectID)

        const firstItem = sessions.find((session) => session.id === firstSession.id)
        const secondItem = sessions.find((session) => session.id === secondSession.id)

        expect(firstItem?.project?.id).toBe(firstProject?.id)
        expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
        expect(secondItem?.project?.id).toBe(secondProject?.id)
        expect(secondItem?.project?.worktree).toBe(secondProject?.worktree)
        expect(first.directory).not.toBe(second)
      }),
    { git: true },
  )

  it.instance(
    "excludes archived sessions by default",
    () =>
      Effect.gen(function* () {
        const archived = yield* withSession({ title: "archived-session" })

        yield* SessionNs.Service.use((session) => session.setArchived({ sessionID: archived.id, time: Date.now() }))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const ids = sessions.map((session) => session.id)

        expect(ids).not.toContain(archived.id)

        const allSessions = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ limit: 200, archived: true }),
        )
        const allIds = allSessions.map((session) => session.id)

        expect(allIds).toContain(archived.id)
      }),
    { git: true },
  )

  it.instance(
    "supports cursor pagination",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const first = yield* withSession({ title: "page-one" })
        const ready = yield* Deferred.make<void>()
        yield* Deferred.succeed(ready, undefined).pipe(Effect.delay("5 millis"), Effect.forkScoped)
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting between session creates")),
          }),
        )
        const second = yield* withSession({ title: "page-two" })

        const page = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 1 }),
        )
        expect(page.length).toBe(1)
        expect(page[0].id).toBe(second.id)

        const next = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 10, cursor: page[0].time.updated }),
        )
        const ids = next.map((session) => session.id)

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      }),
    { git: true },
  )
})

describe("session.searchGlobal", () => {
  it.instance(
    "searches titles and visible text while respecting archive state",
    () =>
      Effect.gen(function* () {
        const title = yield* withSession({ title: `${"t".repeat(200)}Needle in title${"z".repeat(200)}` })
        const visible = yield* withSession({ title: "visible" })
        const hidden = yield* withSession({ title: "hidden" })
        const synthetic = yield* withSession({ title: "synthetic" })
        const reasoning = yield* withSession({ title: "reasoning" })
        const archived = yield* withSession({ title: "archived" })
        const child = yield* withSession({ title: "needle child", parentID: title.id })

        yield* addText(visible.id, `${"x".repeat(200)}needle${"y".repeat(200)}`)
        yield* addText(hidden.id, "needle ignored", { ignored: true })
        yield* addText(synthetic.id, "needle synthetic", { synthetic: true })
        yield* addReasoning(reasoning.id, "needle reasoning")
        yield* addText(archived.id, "needle archived")
        yield* SessionNs.Service.use((session) => session.setArchived({ sessionID: archived.id, time: Date.now() }))

        const active = yield* SessionNs.Service.use((session) => session.searchGlobal({ query: "NEEDLE" }))
        expect(active.data.map((item) => item.sessionID)).toEqual(expect.arrayContaining([title.id, visible.id]))
        expect(active.data.map((item) => item.sessionID)).not.toContain(hidden.id)
        expect(active.data.map((item) => item.sessionID)).not.toContain(synthetic.id)
        expect(active.data.map((item) => item.sessionID)).not.toContain(reasoning.id)
        expect(active.data.map((item) => item.sessionID)).not.toContain(archived.id)
        expect(active.data.map((item) => item.sessionID)).not.toContain(child.id)
        const titleSnippet = active.data.find((item) => item.sessionID === title.id)?.snippet
        expect(titleSnippet).toContain("Needle")
        expect(titleSnippet?.length).toBeLessThanOrEqual(240)
        const snippet = active.data.find((item) => item.sessionID === visible.id)?.snippet
        expect(snippet).toContain("needle")
        expect(snippet?.length).toBeLessThanOrEqual(240)

        const archivedOnly = yield* SessionNs.Service.use((session) =>
          session.searchGlobal({ query: "needle", archived: true }),
        )
        expect(archivedOnly.data.map((item) => item.sessionID)).toEqual([archived.id])
      }),
    { git: true },
  )

  it.instance(
    "supports limits and cursor pagination",
    () =>
      Effect.gen(function* () {
        const first = yield* withSession({ title: "cursor needle first" })
        const second = yield* withSession({ title: "cursor needle second" })
        yield* setUpdated(first.id, 1_000)
        yield* setUpdated(second.id, 1_000)

        const page = yield* SessionNs.Service.use((session) => session.searchGlobal({ query: "needle", limit: 1 }))
        expect(page.data).toHaveLength(1)
        expect(page.cursor).toBeTruthy()

        const next = yield* SessionNs.Service.use((session) =>
          session.searchGlobal({ query: "needle", cursor: page.cursor, limit: 10 }),
        )
        expect(next.data).toHaveLength(1)
        expect(next.data[0].sessionID).not.toBe(page.data[0].sessionID)
      }),
    { git: true },
  )
})
