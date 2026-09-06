import { describe, expect, test } from "bun:test"
import { createApiForServer, createSdkForServer } from "./server"
import { createCompatibleApi, sessionCapabilities } from "./server-compat"

function setup(
  protocol: "v1" | "v2" | Promise<"v1" | "v2">,
  responses?: {
    vcs?: { branch: string; default_branch: string }
    echoPermissionMode?: boolean
    lifecycleStatus?: number
    capabilitiesFailures?: number
    capabilitiesStatus?: number
    capabilities?: { archive: boolean; restore: boolean; delete: boolean; managedWorktree: boolean }
  },
) {
  const requests: Request[] = []
  let capabilitiesFailures = responses?.capabilitiesFailures ?? 0
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === "PATCH") {
        const body = (await request.clone().json()) as { permissionMode?: "default" | "auto" | "full" }
        return Response.json({
          id: "ses_1",
          slug: "ses_1",
          projectID: "project",
          directory: "/repo",
          title: "Session",
          version: "1",
          time: { created: 1, updated: 1 },
          permissionMode: responses?.echoPermissionMode ? body.permissionMode : undefined,
        })
      }
      if (request.method === "POST" && request.url.endsWith("/prompt_async"))
        return new Response(undefined, { status: 204 })
      if (request.method === "POST" && request.url.endsWith("/prompt")) {
        return Response.json({
          admittedSeq: 1,
          id: "msg_1",
          sessionID: "ses_1",
          timeCreated: 1,
          type: "user",
          data: { text: "hello" },
          delivery: "steer",
        })
      }
      if (request.method === "GET" && new URL(request.url).pathname === "/vcs")
        return Response.json(responses?.vcs ?? {})
      if (request.method === "GET" && new URL(request.url).pathname === "/api/session/capabilities") {
        if (responses?.capabilitiesStatus)
          return Response.json({ message: "capabilities unsupported" }, { status: responses.capabilitiesStatus })
        if (capabilitiesFailures > 0) {
          capabilitiesFailures--
          return Response.json({ message: "capabilities failed" }, { status: 503 })
        }
        return Response.json({
          data: {
            ...(responses?.capabilities ?? { archive: true, restore: true, delete: true, managedWorktree: true }),
            occupancy: { pty: true, v2: true, externalProcesses: false },
          },
        })
      }
      if (responses?.lifecycleStatus && new URL(request.url).pathname.startsWith("/api/session/")) {
        return Response.json({ message: "lifecycle failed" }, { status: responses.lifecycleStatus })
      }
      if (request.method === "GET") return Response.json([])
      return new Response(undefined, { status: 204 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createCompatibleApi({
    protocol: typeof protocol === "string" ? Promise.resolve(protocol) : protocol,
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    directory: "/repo",
  })
  return { api, requests }
}

describe("createCompatibleApi", () => {
  test("routes V1 archive through the legacy session update", async () => {
    const { api, requests } = setup("v1")
    await api.session.archive({ sessionID: "ses_1", directory: "/repo" })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/session/ses_1")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[0]!.method).toBe("PATCH")
    expect(await requests[0]!.json()).toMatchObject({ time: { archived: expect.any(Number) } })
  })

  test("loads a V1 session from the requested project directory", async () => {
    const { api, requests } = setup("v1")

    await api.session.get({ sessionID: "ses_1", directory: "/other" })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/session/ses_1")
    expect(url.searchParams.get("directory")).toBe("/other")
  })

  test("uses actual bundled capabilities for V1 and restores through the legacy update", async () => {
    const { api, requests } = setup("v1")

    expect(await sessionCapabilities(api)).toEqual({
      archive: true,
      restore: true,
      delete: true,
      managedWorktree: true,
      occupancy: { pty: true, v2: true, externalProcesses: false },
    })
    await api.session.restore({ sessionID: "ses_1", directory: "/repo" })

    expect(requests).toHaveLength(2)
    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/capabilities")
    expect(await requests[1]!.json()).toMatchObject({ time: { archived: null } })
  })

  test("falls back to known legacy lifecycle capabilities when the V1 endpoint is unsupported", async () => {
    const { api } = setup("v1", { capabilitiesStatus: 404 })

    expect(await sessionCapabilities(api)).toEqual({
      archive: true,
      restore: true,
      delete: true,
      managedWorktree: false,
      occupancy: { pty: false, v2: false, externalProcesses: false },
    })
  })

  test("retries transient V1 capability discovery instead of caching a conservative fallback", async () => {
    const { api, requests } = setup("v1", { capabilitiesFailures: 1 })

    await expect(sessionCapabilities(api)).rejects.toThrow("capabilities failed")
    expect((await sessionCapabilities(api)).occupancy.v2).toBe(true)
    expect(requests.filter((request) => new URL(request.url).pathname === "/api/session/capabilities")).toHaveLength(2)
  })

  test("converts current prompts to the V1 prompt contract", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello @src/index.ts",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      files: [
        { uri: "file:///repo/src/index.ts", name: "index.ts", mention: { text: "@src/index.ts", start: 6, end: 19 } },
        { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
      ],
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/prompt_async")
    const body = await requests[0]!.json()
    expect(body).toMatchObject({
      messageID: "msg_1",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      parts: [
        { type: "text", text: "hello @src/index.ts" },
        {
          type: "file",
          mime: "text/plain",
          url: "file:///repo/src/index.ts",
          filename: "index.ts",
          source: {
            type: "file",
            text: { value: "@src/index.ts", start: 6, end: 19 },
            path: "file:///repo/src/index.ts",
          },
        },
        {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGVsbG8=",
          filename: "notes.txt",
        },
      ],
    })
    expect(body.parts[2]).not.toHaveProperty("source")
  })

  test("preserves original parts for V1 optimistic reconciliation", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "look",
      files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }],
      legacyParts: [
        { id: "prt_text", type: "text", text: "look" },
        { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
      ],
    })

    expect((await requests[0]!.json()).parts).toEqual([
      { id: "prt_text", type: "text", text: "look" },
      { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
    ])
  })

  test("resolves protocol detection once across implementation methods", async () => {
    let detections = 0
    const resolved = Promise.resolve<"v1" | "v2">("v2")
    const protocol = new Proxy(resolved, {
      get(target, property) {
        if (property !== "then") return Reflect.get(target, property, target)
        detections++
        return target.then.bind(target)
      },
    })
    const { api } = setup(protocol)

    await api.session.list()
    await api.session.list()

    expect(detections).toBe(1)
  })

  test("keeps V2 session actions on the current API", async () => {
    const { api, requests } = setup("v2")
    await api.session.archive({ sessionID: "ses_1" })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/archive")
    expect(requests[0]!.method).toBe("POST")
  })

  test("uses actual V2 lifecycle capabilities and propagates lifecycle failures", async () => {
    const { api, requests } = setup("v2", {
      capabilities: { archive: false, restore: false, delete: false, managedWorktree: false },
      lifecycleStatus: 409,
    })

    expect(await api.session.capabilities()).toMatchObject({ archive: false, restore: false, delete: false })
    await expect(api.session.restore({ sessionID: "ses_1" })).rejects.toThrow("lifecycle failed")
    await expect(api.session.remove({ sessionID: "ses_1" })).rejects.toThrow("lifecycle failed")
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/session/capabilities",
      "/api/session/ses_1/restore",
      "/api/session/ses_1",
    ])
  })

  test("shares one actual capability request across UI consumers", async () => {
    const { api, requests } = setup("v2")

    const [first, second] = await Promise.all([sessionCapabilities(api), sessionCapabilities(api)])

    expect(second).toEqual(first)
    expect(requests.filter((request) => new URL(request.url).pathname === "/api/session/capabilities")).toHaveLength(1)
  })

  test("retries capability discovery after a transient failure", async () => {
    const { api, requests } = setup("v2", { capabilitiesFailures: 1 })

    await expect(sessionCapabilities(api)).rejects.toThrow("capabilities failed")
    expect((await sessionCapabilities(api)).archive).toBe(true)
    expect(requests.filter((request) => new URL(request.url).pathname === "/api/session/capabilities")).toHaveLength(2)
  })

  test("uses the global V1 session search endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.list({ parentID: null, search: "session", limit: 50 })

    expect(new URL(requests[0]!.url).pathname).toBe("/experimental/session")
  })

  /*
  test("projects the V1 default branch", async () => {
    const { api } = setup("v1", { vcs: { branch: "feature", default_branch: "dev" } })

    expect(await api.vcs.get({ location: { directory: "/repo" } })).toMatchObject({
      data: { branch: "feature", defaultBranch: "dev" },
    })
  })
  */

  test("translates current file searches to the V1 dirs parameter", async () => {
    const { api, requests } = setup("v1")
    await api.file.find({ location: { directory: "/repo" }, query: "src", type: "file", limit: 20 })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/find/file")
    expect(url.searchParams.get("dirs")).toBe("false")
    expect(url.searchParams.get("limit")).toBe("20")
  })

  test("routes V1 permission replies through the requested directory", async () => {
    const { api, requests } = setup("v1")
    await api.permission.reply({
      sessionID: "ses_1",
      requestID: "permission_1",
      reply: "once",
      location: { directory: "/other" },
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/permissions/permission_1")
    expect(new URL(requests[0]!.url).searchParams.get("directory")).toBe("/other")
  })

  test("routes V1 permission mode changes through session update", async () => {
    const { api, requests } = setup("v1", { echoPermissionMode: true })

    await api.session.setPermissionMode({
      sessionID: "ses_1",
      permissionMode: "full",
      location: { directory: "/other" },
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe(encodeURIComponent("/other"))
    expect(requests[0]!.method).toBe("PATCH")
    expect(await requests[0]!.json()).toMatchObject({ permissionMode: "full" })
  })

  test("rejects V1 servers that ignore permission mode changes", async () => {
    const { api } = setup("v1")

    expect(
      api.session.setPermissionMode({ sessionID: "ses_1", permissionMode: "full", location: { directory: "/repo" } }),
    ).rejects.toThrow("Permission update failed")
  })

  test("disposes the V1 instance after connecting a provider", async () => {
    const { api, requests } = setup("v1")

    await api.integration.connect.key({
      integrationID: "openrouter",
      key: "secret",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/auth/openrouter",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[1]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[2]!.headers.get("x-opencode-directory")).toBeNull()
  })

  test("disposes the V1 instance after completing provider OAuth", async () => {
    const { api, requests } = setup("v1")

    await api.integration.oauth.complete({
      integrationID: "openrouter",
      attemptID: "openrouter:0",
      code: "code",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/provider/openrouter/oauth/callback",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[1]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[2]!.headers.get("x-opencode-directory")).toBeNull()
  })
})
