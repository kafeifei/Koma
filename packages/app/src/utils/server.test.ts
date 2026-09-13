import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, createApiForServer } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

describe("permission mode transport", () => {
  test("includes permission mode in current session creation", async () => {
    const requests: Request[] = []
    const api = createApiForServer({
      server: { url: "http://localhost:4096" },
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(new Request(input, init))
          return Response.json({
            data: {
              id: "session-1",
              projectID: "project",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, updated: 1 },
              title: "Session",
              location: { directory: "/repo" },
              permissionMode: "full",
            },
          })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })

    const session = await api.session.create({
      location: { directory: "/repo" },
      permissionMode: "full",
    })

    expect(session.permissionMode).toBe("full")
    expect(new URL(requests[0]!.url).pathname).toBe("/api/session")
    expect(await requests[0]!.json()).toMatchObject({ permissionMode: "full" })
  })

  test("posts permission mode changes through the authenticated transport", async () => {
    const requests: Request[] = []
    const api = createApiForServer({
      server: { url: "http://localhost:4096", username: "kit", password: "secret" },
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(new Request(input, init))
          return new Response(undefined, { status: 204 })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })

    await api.session.setPermissionMode({ sessionID: "session-1", permissionMode: "auto" })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/session-1/permission-mode")
    expect(requests[0]!.headers.get("authorization")).toBe(`Basic ${btoa("kit:secret")}`)
    expect(await requests[0]!.json()).toEqual({ permissionMode: "auto" })
  })
})

describe("directory transport", () => {
  test("lists an absolute path through the authenticated global endpoint", async () => {
    const requests: Request[] = []
    const api = createApiForServer({
      server: { url: "http://localhost:4096", username: "kit", password: "secret" },
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(new Request(input, init))
          return Response.json({ data: [{ name: "src", path: "/repo/src", type: "directory" }] })
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })

    expect(await api.directory.list({ path: "/repo" })).toEqual([{ name: "src", path: "/repo/src", type: "directory" }])
    expect(new URL(requests[0]!.url).pathname).toBe("/api/directory")
    expect(new URL(requests[0]!.url).searchParams.get("path")).toBe("/repo")
    expect(requests[0]!.headers.get("authorization")).toBe(`Basic ${btoa("kit:secret")}`)
  })
})

describe("extension management transport", () => {
  test("uses the selected server and credentials and preserves project and package identities", async () => {
    const requests: Request[] = []
    const api = createApiForServer({
      server: { url: "https://remote.example", username: "user", password: "test-password" },
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(new Request(input, init))
          return Response.json([])
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    })
    await api.extensions.install({ spec: "@scope/plugin@1.0.0", options: {} })
    await api.extensions.uninstall("@scope/plugin")
    await api.extensions.saveIntegration("/projects/A & B", {
      name: "demo",
      config: { type: "remote", url: "https://mcp.example" },
    })
    expect(requests.every((r) => new URL(r.url).origin === "https://remote.example")).toBe(true)
    expect(requests.every((r) => r.headers.get("authorization") === `Basic ${btoa("user:test-password")}`)).toBe(true)
    expect(decodeURIComponent(new URL(requests[1]!.url).pathname)).toBe("/global/extensions/plugins/@scope/plugin")
    expect(new URL(requests[2]!.url).searchParams.get("directory")).toBe("/projects/A & B")
    expect(await requests[0]!.json()).toEqual({ spec: "@scope/plugin@1.0.0", options: {} })
  })
})
