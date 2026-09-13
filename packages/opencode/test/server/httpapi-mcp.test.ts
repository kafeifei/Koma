import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffect(testStateLayer)

function app() {
  return Server.Default().app
}
type TestApp = ReturnType<typeof app>
type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

const request = Effect.fnUntraced(function* (
  handler: TestHandler,
  route: string,
  directory: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return yield* Effect.promise(() =>
    Promise.resolve(
      handler.handler(
        new Request(`http://localhost${route}`, {
          ...init,
          headers,
        }),
        context,
      ),
    ),
  )
})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const readResponse = Effect.fnUntraced(function* (input: { app: TestApp; path: string; headers: HeadersInit }) {
  const response = yield* Effect.promise(() =>
    Promise.resolve(input.app.request(input.path, { method: "POST", headers: input.headers })),
  )
  return {
    status: response.status,
    body: yield* Effect.promise(() => response.text()),
  }
})

describe("mcp HttpApi", () => {
  it.instance(
    "serves status endpoint",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const response = yield* request(handler, McpPaths.status, tmp.directory)

        expect(response.status).toBe(200)
        expect(yield* json(response)).toEqual({ demo: { status: "disabled" } })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves add, connect, and disconnect endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const added = yield* request(handler, McpPaths.status, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "added",
            config: {
              type: "local",
              command: ["echo", "added"],
              enabled: false,
            },
          }),
        })
        expect(added.status).toBe(200)
        expect(yield* json(added)).toMatchObject({ added: { status: "disabled" } })

        const addedDisconnected = yield* request(handler, "/mcp/added/disconnect", tmp.directory, { method: "POST" })
        expect(addedDisconnected.status).toBe(200)
        expect(yield* json(addedDisconnected)).toBe(true)

        const connected = yield* request(handler, "/mcp/demo/connect", tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)
        expect(yield* json(connected)).toBe(true)

        const disconnected = yield* request(handler, "/mcp/demo/disconnect", tmp.directory, { method: "POST" })
        expect(disconnected.status).toBe(200)
        expect(yield* json(disconnected)).toBe(true)
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves deterministic OAuth endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const start = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "POST" })
        expect(start.status).toBe(400)

        const authenticate = yield* request(handler, "/mcp/demo/auth/authenticate", tmp.directory, { method: "POST" })
        expect(authenticate.status).toBe(400)

        const removed = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(yield* json(removed)).toEqual({ success: true })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "returns unsupported OAuth error responses",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const dir = tmp.directory
        const headers = { "x-opencode-directory": dir }

        yield* Effect.forEach(["/mcp/demo/auth", "/mcp/demo/auth/authenticate"], (path) =>
          Effect.gen(function* () {
            const response = yield* readResponse({ app: app(), path, headers })

            expect(response).toEqual({
              status: 400,
              body: JSON.stringify({ error: "MCP server demo does not support OAuth" }),
            })
          }),
        )
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "returns typed not found errors for missing MCP servers",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()

        for (const input of [
          { method: "POST", route: "/mcp/missing/auth" },
          { method: "POST", route: "/mcp/missing/auth/authenticate" },
          { method: "POST", route: "/mcp/missing/auth/callback", body: JSON.stringify({ code: "code" }) },
          { method: "DELETE", route: "/mcp/missing/auth" },
          { method: "POST", route: "/mcp/missing/connect" },
          { method: "POST", route: "/mcp/missing/disconnect" },
        ]) {
          const response = yield* request(handler, input.route, tmp.directory, {
            method: input.method,
            headers: input.body ? { "content-type": "application/json" } : undefined,
            body: input.body,
          })

          expect(response.status).toBe(404)
          expect(yield* json(response)).toEqual({
            _tag: "McpServerNotFoundError",
            name: "missing",
            message: "MCP server not found: missing",
          })
        }
      }),
    { config: { mcp: {} } },
  )
})

describe("Koma integration management HttpApi", () => {
  it.instance("rejects the computer control name before changing the integration store", () =>
    Effect.gen(function* () {
      const { readStore } = yield* Effect.promise(() => import("../../src/koma/extensions/store"))
      const before = yield* Effect.promise(() => readStore())
      const tmp = yield* TestInstance
      const handler = HttpApiApp.webHandler()
      const name = "koma-computer-use"
      for (const input of [
        {
          method: "PUT",
          route: "/extensions/integrations",
          body: JSON.stringify({ name, config: { type: "local", command: ["echo", "must-not-run"] } }),
        },
        { method: "DELETE", route: `/extensions/integrations/${name}` },
      ]) {
        const response = yield* request(handler, input.route, tmp.directory, {
          method: input.method,
          headers: { "content-type": "application/json" },
          body: input.body,
        })
        expect(response.status).toBe(400)
        expect(yield* json(response)).toMatchObject({
          message: "Manage computer control in Settings > Computer control.",
        })
      }
      expect(yield* Effect.promise(() => readStore())).toEqual(before)
    }),
  )

  it.instance("persists managed connections and removes only the selected project entry", () =>
    Effect.gen(function* () {
      const { readStore, updateStore } = yield* Effect.promise(() => import("../../src/koma/extensions/store"))
      const before = yield* Effect.promise(() => readStore())
      yield* Effect.addFinalizer(() => Effect.promise(() => updateStore(() => before)))
      const tmp = yield* TestInstance
      const handler = HttpApiApp.webHandler()
      const saved = yield* request(handler, "/extensions/integrations", tmp.directory, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "managed",
          config: { type: "remote", url: "https://example.com/mcp", enabled: false },
        }),
      })
      expect(saved.status).toBe(200)
      expect(yield* json(saved)).toMatchObject([{ name: "managed", managed: true, enabled: false, status: "disabled" }])
      const stored = yield* Effect.promise(() => readStore())
      expect(stored.integrations[tmp.directory]?.managed?.enabled).toBe(false)
      const removed = yield* request(handler, "/extensions/integrations/managed", tmp.directory, { method: "DELETE" })
      expect(removed.status).toBe(200)
      expect(yield* json(removed)).toEqual([])
      expect((yield* Effect.promise(() => readStore())).integrations[tmp.directory]?.managed).toBeUndefined()
    }),
  )

  it.instance(
    "rejects changes to integrations owned by a config file",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const removed = yield* request(handler, "/extensions/integrations/external", tmp.directory, {
          method: "DELETE",
        })
        expect(removed.status).toBe(400)
        expect(yield* json(removed)).toMatchObject({
          message: "This integration is managed by an existing configuration file.",
        })
      }),
    { config: { mcp: { external: { type: "remote", url: "https://example.com", enabled: false } } } },
  )
})

it.instance("rejects integration changes while the project runtime is busy", () =>
  Effect.gen(function* () {
    const { AppRuntime } = yield* Effect.promise(() => import("../../src/effect/app-runtime"))
    const { InstanceState } = yield* Effect.promise(() => import("../../src/effect/instance-state"))
    const { InstanceRef } = yield* Effect.promise(() => import("../../src/effect/instance-ref"))
    const { SessionStatus } = yield* Effect.promise(() => import("../../src/session/status"))
    const { SessionID } = yield* Effect.promise(() => import("../../src/session/schema"))
    const instance = yield* InstanceState.context
    const id = SessionID.make("ses_extension_busy_test")
    // HttpApiApp uses the production runtime; set the status in that same runtime.
    const set = (type: "busy" | "idle") =>
      Effect.promise(() =>
        AppRuntime.runPromise(
          SessionStatus.Service.use((s) => s.set(id, { type })).pipe(Effect.provideService(InstanceRef, instance)),
        ),
      )
    yield* set("busy")
    yield* Effect.addFinalizer(() => set("idle"))
    const result = yield* request(HttpApiApp.webHandler(), "/extensions/integrations", instance.directory, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "busy-check", config: { type: "local", command: ["echo", "must-not-run"] } }),
    })
    expect(result.status).toBe(409)
    const { readStore } = yield* Effect.promise(() => import("../../src/koma/extensions/store"))
    expect((yield* Effect.promise(() => readStore())).integrations[instance.directory]?.["busy-check"]).toBeUndefined()
  }),
)
