import { $ } from "bun"
import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { SessionID } from "../../src/session/schema"
import { WorktreeLifecycle } from "../../src/worktree/lifecycle"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([WorktreeLifecycle.node, Database.node])), httpApiLayer),
)
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

describe("delete an abandoned worktree archive through HTTP", () => {
  for (const api of ["/session", "/api/session"] as const) {
    it.live(
      `${api} deletes the stale task family and retains unrelated native tasks`,
      () =>
        Effect.gen(function* () {
          const root = yield* tmpdirScoped({ git: true })
          const created = yield* requestInDirectory("/experimental/worktree", root, json({ wait: true }))
          expect(created.status).toBe(200)
          const worktree = (yield* created.json) as { directory: string; branch: string }
          const admitted = yield* requestInDirectory(
            "/session",
            worktree.directory,
            json({ title: "abandoned archive" }),
          )
          expect(admitted.status).toBe(200)
          const session = (yield* admitted.json) as { id: string; projectID: string }
          const sessionID = SessionID.make(session.id)
          const child = SessionID.descending()
          const peer = SessionID.descending()
          const { db } = yield* Database.Service
          const lifecycle = yield* WorktreeLifecycle.Service

          // Reproduce the retained intent from the old backend, with no checkout,
          // branch or archive snapshot and unrelated native owners still recorded.
          expect(yield* lifecycle.prepareArchive(sessionID)).toMatchObject({ managed: true })
          yield* db
            .update(SessionTable)
            .set({ time_archived: Date.now() })
            .where(eq(SessionTable.id, sessionID))
            .run()
            .pipe(Effect.orDie)
          const row = yield* db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.die("fixture session disappeared")
          yield* db
            .insert(SessionTable)
            .values([
              { ...row, id: child, slug: child, parent_id: sessionID, time_archived: null },
              { ...row, id: peer, slug: peer, title: "unrelated native task", engine: "codex", time_archived: null },
            ])
            .run()
            .pipe(Effect.orDie)
          yield* Effect.promise(() => $`git worktree remove --force ${worktree.directory}`.cwd(root).quiet())
          yield* Effect.promise(() => $`git branch -D ${worktree.branch}`.cwd(root).quiet())

          const removed = yield* requestInDirectory(`${api}/${sessionID}`, worktree.directory, { method: "DELETE" })
          expect({ status: removed.status, body: yield* removed.text }).toMatchObject({
            status: api === "/session" ? 200 : 204,
          })
          expect(yield* lifecycle.get(sessionID)).toBeUndefined()
          for (const id of [sessionID, child]) {
            expect(
              yield* db
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(eq(SessionTable.id, id))
                .get()
                .pipe(Effect.orDie),
            ).toBeUndefined()
          }
          expect(
            yield* db
              .select({ id: SessionTable.id, title: SessionTable.title })
              .from(SessionTable)
              .where(eq(SessionTable.id, peer))
              .get()
              .pipe(Effect.orDie),
          ).toEqual({ id: peer, title: "unrelated native task" })
          expect(yield* Effect.promise(() => $`git status --porcelain`.cwd(root).text())).toBe("")
        }),
      30_000,
    )
  }
})
