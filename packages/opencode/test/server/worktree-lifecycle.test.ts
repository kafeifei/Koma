import fs from "node:fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
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
      expect({ status: archived.status, body: yield* archived.json }).toMatchObject({ status: 200 })
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

describe("managed worktree V2 lifecycle", () => {
  it.live("advertises the bundled lifecycle integration and restores after checkout removal", () =>
    Effect.gen(function* () {
      const temp = yield* tmpdirScoped({ git: true })
      const capabilities = yield* requestInDirectory("/api/session/capabilities", temp)
      expect(capabilities.status).toBe(200)
      expect(yield* capabilities.json).toMatchObject({
        data: {
          archive: true,
          restore: true,
          delete: true,
          managedWorktree: true,
          occupancy: { pty: true, v2: true, externalProcesses: false },
        },
      })
      const created = yield* requestInDirectory("/experimental/worktree", temp, json("POST", { wait: true }))
      expect(created.status).toBe(200)
      const worktree = (yield* created.json) as { directory: string }
      yield* Effect.promise(() => fs.writeFile(`${worktree.directory}/draft.txt`, "v2 retained draft"))
      const admitted = yield* requestInDirectory(
        "/api/session",
        temp,
        json("POST", { location: { directory: worktree.directory } }),
      )
      expect(admitted.status).toBe(200)
      const session = (yield* admitted.json) as { data: { id: string } }
      const route = `/api/session/${session.data.id}`
      expect((yield* requestInDirectory(`${route}/archive`, temp, { method: "POST" })).status).toBe(204)
      expect(
        yield* Effect.promise(() =>
          fs.access(worktree.directory).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect((yield* requestInDirectory(`${route}/restore`, temp, { method: "POST" })).status).toBe(204)
      expect(yield* Effect.promise(() => fs.readFile(`${worktree.directory}/draft.txt`, "utf8"))).toBe(
        "v2 retained draft",
      )
      expect((yield* requestInDirectory(route, temp, { method: "DELETE" })).status).toBe(204)
      expect(
        yield* Effect.promise(() =>
          fs.access(worktree.directory).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect((yield* requestInDirectory(`${route}/restore`, temp, { method: "POST" })).status).toBe(404)
    }),
  )

  for (const [api, sameLocation] of [
    ["/pty", false],
    ["/api/pty", false],
    ["/api/pty", true],
  ] as const) {
    it.live(
      `keeps ${api} checkout usage (${sameLocation ? "own" : "other"} Location) and rejects new terminals during archive`,
      () =>
        Effect.gen(function* () {
          const temp = yield* tmpdirScoped({ git: true })
          const created = yield* requestInDirectory("/experimental/worktree", temp, json("POST", { wait: true }))
          expect(created.status).toBe(200)
          const worktree = (yield* created.json) as { directory: string }
          yield* Effect.promise(() => fs.mkdir(`${worktree.directory}/subdir`))
          const admitted = yield* requestInDirectory(
            "/api/session",
            temp,
            json("POST", { location: { directory: worktree.directory } }),
          )
          expect(admitted.status).toBe(200)
          const session = (yield* admitted.json) as { data: { id: string } }
          const route = `/api/session/${session.data.id}`
          const terminalDirectory = sameLocation ? worktree.directory : temp
          // Exercise both a different Location and disposal initiated from the terminal's own Location.
          const terminal = yield* requestInDirectory(
            api,
            terminalDirectory,
            json("POST", { command: "/bin/cat", cwd: `${worktree.directory}/subdir` }),
          )
          expect(terminal.status).toBe(200)
          const body = (yield* terminal.json) as { id?: string; data?: { id: string } }
          const ptyID = body.data?.id ?? body.id!
          expect((yield* requestInDirectory(`${route}/archive`, temp, { method: "POST" })).status).toBe(204)
          expect(
            yield* Effect.promise(() =>
              fs.access(worktree.directory).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(true)
          const status = yield* requestInDirectory(`/experimental/session/${session.data.id}/worktree`, temp)
          expect(yield* status.json).toMatchObject({ managed: true, state: "pending", operation: "archive" })
          const blocked = yield* requestInDirectory(api, worktree.directory, json("POST", { command: "/bin/cat" }))
          expect(blocked.status).toBe(409)
          expect(yield* blocked.json).toMatchObject({ _tag: "ConflictError" })
          expect((yield* requestInDirectory(`${route}`, temp, { method: "DELETE" })).status).toBe(409)
          const removed = yield* requestInDirectory(`${api}/${ptyID}`, terminalDirectory, { method: "DELETE" })
          expect(removed.status).toBe(api === "/pty" ? 200 : 204)
          yield* Effect.repeat(
            Effect.promise(() =>
              fs.access(worktree.directory).then(
                () => true,
                () => false,
              ),
            ),
            {
              while: (exists) => exists,
              schedule: Schedule.spaced("20 millis"),
            },
          ).pipe(Effect.timeout("10 seconds"))
          expect((yield* requestInDirectory(`${route}/restore`, temp, { method: "POST" })).status).toBe(204)
          expect((yield* requestInDirectory(route, temp, { method: "DELETE" })).status).toBe(204)
        }),
    )
  }
})
