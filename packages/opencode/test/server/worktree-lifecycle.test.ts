import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const state = Layer.effectDiscard(
  Effect.gen(function* () {
    const previous = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = previous
        await resetDatabase()
      }),
    )
  }),
)
const it = testEffect(Layer.mergeAll(state, httpApiLayer))
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

describe("managed worktree HTTP lifecycle", () => {
  it.live("creates, archives, restores and deletes through the project root", () =>
    Effect.gen(function* () {
      const temp = yield* tmpdirScoped({ git: true })
      const options = yield* requestInDirectory("/experimental/worktree/options", temp)
      expect(options.status).toBe(200)
      expect(yield* options.json).toMatchObject({ hasHead: true })
      const created = yield* requestInDirectory("/experimental/worktree", temp, json("POST", { wait: true }))
      expect(created.status).toBe(200)
      const worktree = (yield* created.json) as { directory: string; branch: string }
      yield* Effect.promise(() => Bun.write(`${worktree.directory}/draft.txt`, "keep my untracked changes"))
      const admitted = yield* requestInDirectory(
        "/session",
        worktree.directory,
        json("POST", { title: "Lifecycle through HTTP" }),
      )
      expect(admitted.status).toBe(200)
      const session = (yield* admitted.json) as { id: string }
      const route = `/session/${session.id}`
      const status = `/experimental/session/${session.id}/worktree`
      const before = yield* requestInDirectory(status, temp)
      expect(yield* before.json).toMatchObject({ managed: true, state: "resident" })
      const archived = yield* requestInDirectory(route, temp, json("PATCH", { time: { archived: Date.now() } }))
      expect(archived.status).toBe(200)
      expect(yield* Effect.promise(() => Bun.file(`${worktree.directory}/draft.txt`).exists())).toBe(false)
      const archiveStatus = yield* requestInDirectory(status, temp)
      expect(yield* archiveStatus.json).toMatchObject({ state: "archived" })
      const restored = yield* requestInDirectory(route, temp, json("PATCH", { time: { archived: null } }))
      expect(restored.status).toBe(200)
      expect(yield* Effect.promise(() => Bun.file(`${worktree.directory}/draft.txt`).text())).toBe(
        "keep my untracked changes",
      )
      const restoreStatus = yield* requestInDirectory(status, temp)
      expect(yield* restoreStatus.json).toMatchObject({ state: "resident" })
      const removed = yield* requestInDirectory(route, temp, { method: "DELETE" })
      expect(removed.status).toBe(200)
      expect(yield* Effect.promise(() => Bun.file(`${worktree.directory}/draft.txt`).exists())).toBe(false)
      expect((yield* requestInDirectory(route, temp)).status).toBe(404)
      const deleteStatus = yield* requestInDirectory(status, temp)
      expect(yield* deleteStatus.json).toEqual({ managed: false })
    }),
  )
})
