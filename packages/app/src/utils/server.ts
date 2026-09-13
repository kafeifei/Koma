import type { PluginInfo, PluginInput, IntegrationInfo, ExtensionCatalog } from "@opencode-ai/schema/koma-extensions"
import type { Attempt } from "@opencode-ai/schema/integration"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export type ServerPermissionMode = "default" | "auto" | "full"
// The vendored client predates the explicit OAuth confirmation code field.
type ServerOAuthConnectOutput = Awaited<ReturnType<OpenCodeClient["integration"]["oauth"]["connect"]>>
export type ServerOAuthAuthorization = ServerOAuthConnectOutput["data"] & Pick<Attempt, "code">
export type ServerSessionInfo = Awaited<ReturnType<OpenCodeClient["session"]["get"]>> & {
  permissionMode?: ServerPermissionMode
}
type ServerSessionCreateInput = NonNullable<Parameters<OpenCodeClient["session"]["create"]>[0]> & {
  permissionMode?: ServerPermissionMode
}
type ServerSessionSetPermissionModeInput = {
  sessionID: string
  permissionMode: ServerPermissionMode
  location?: { directory?: string }
}
type ServerSessionCapabilities = {
  archive: boolean
  restore: boolean
  delete: boolean
  managedWorktree: boolean
  occupancy: { pty: boolean; v2: boolean; externalProcesses: false }
}
type ServerSessionLifecycleInput = { sessionID: string; directory?: string }
export type ServerDirectoryEntry = { name: string; path: string; type: "file" | "directory" }

export class ServerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "ServerHttpError"
  }
}

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: { server: ServerConnection.HttpBase; fetch?: typeof globalThis.fetch }) {
  const headers = input.server.password
    ? {
        Authorization: `Basic ${authTokenFromCredentials({
          username: input.server.username,
          password: input.server.password,
        })}`,
      }
    : undefined
  const client = OpenCode.make({
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers,
  })
  // The app intentionally remains on the vendored singular-session client. Remove
  // these transport extensions when it supports permission modes and lifecycle endpoints.
  const request = async (path: string, value: RequestInit) => {
    const requestHeaders = new Headers(headers)
    new Headers(value.headers).forEach((item, key) => requestHeaders.set(key, item))
    if (!requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json")
    const response = await (input.fetch ?? globalThis.fetch)(new URL(path, input.server.url), {
      ...value,
      headers: requestHeaders,
    })
    if (response.ok) return response
    const body = (await response.json().catch(() => undefined)) as
      | { message?: string; data?: { message?: string } }
      | undefined
    throw new ServerHttpError(
      body?.data?.message ?? body?.message ?? `Request failed with status ${response.status}`,
      response.status,
    )
  }

  return {
    ...client,
    integration: {
      ...client.integration,
      oauth: {
        ...client.integration.oauth,
        connect: (...args: Parameters<OpenCodeClient["integration"]["oauth"]["connect"]>) =>
          client.integration.oauth.connect(...args) as Promise<
            ServerOAuthConnectOutput & { data: ServerOAuthAuthorization }
          >,
      },
    },
    extensions: {
      installCatalog: (id: string) =>
        request("/global/extensions/catalog/install", { method: "POST", body: JSON.stringify({ id }) }).then(
          (r) => r.json() as Promise<PluginInfo[]>,
        ),
      catalog: (refresh = false) =>
        request(`/global/extensions/catalog${refresh ? "/refresh" : ""}`, { method: refresh ? "POST" : "GET" }).then(
          (r) => r.json() as Promise<ExtensionCatalog>,
        ),
      plugins: () =>
        request("/global/extensions/plugins", { method: "GET" }).then((r) => r.json() as Promise<PluginInfo[]>),
      install: (value: PluginInput) =>
        request("/global/extensions/plugins", { method: "POST", body: JSON.stringify(value) }).then(
          (r) => r.json() as Promise<PluginInfo[]>,
        ),
      change: (value: { id: string; enabled: boolean; options?: Record<string, unknown> }) =>
        request("/global/extensions/plugins", { method: "PATCH", body: JSON.stringify(value) }).then(
          (r) => r.json() as Promise<PluginInfo[]>,
        ),
      uninstall: (id: string) =>
        request("/global/extensions/plugins/remove", { method: "POST", body: JSON.stringify({ id }) }).then(
          (r) => r.json() as Promise<PluginInfo[]>,
        ),
      integrations: (directory: string) =>
        request(`/extensions/integrations?directory=${encodeURIComponent(directory)}`, { method: "GET" }).then(
          (r) => r.json() as Promise<IntegrationInfo[]>,
        ),
      saveIntegration: (directory: string, value: { name: string; config: Record<string, unknown> }) =>
        request(`/extensions/integrations?directory=${encodeURIComponent(directory)}`, {
          method: "PUT",
          body: JSON.stringify(value),
        }).then((r) => r.json() as Promise<IntegrationInfo[]>),
      removeIntegration: (directory: string, name: string) =>
        request(`/extensions/integrations/${encodeURIComponent(name)}?directory=${encodeURIComponent(directory)}`, {
          method: "DELETE",
        }).then((r) => r.json() as Promise<IntegrationInfo[]>),
    },
    directory: {
      async list(value: { path: string }) {
        const url = new URL("/api/directory", input.server.url)
        url.searchParams.set("path", value.path)
        return (
          (await (await request(url.toString(), { method: "GET" })).json()) as {
            data: ServerDirectoryEntry[]
          }
        ).data
      },
    },
    session: {
      ...client.session,
      create: async (
        value?: ServerSessionCreateInput,
        options?: Parameters<OpenCodeClient["session"]["create"]>[1],
      ) => {
        if (value?.permissionMode === undefined)
          return client.session.create(value, options) as Promise<ServerSessionInfo>
        const response = await request("/api/session", {
          method: "POST",
          signal: options?.signal,
          headers: options?.headers,
          body: JSON.stringify({
            id: value.id,
            agent: value.agent,
            model: value.model,
            location: value.location,
            permissionMode: value.permissionMode,
          }),
        })
        return ((await response.json()) as { data: ServerSessionInfo }).data
      },
      get: (
        value: Parameters<OpenCodeClient["session"]["get"]>[0],
        options?: Parameters<OpenCodeClient["session"]["get"]>[1],
      ) => client.session.get(value, options) as Promise<ServerSessionInfo>,
      async setPermissionMode(value: ServerSessionSetPermissionModeInput) {
        await request(`/api/session/${encodeURIComponent(value.sessionID)}/permission-mode`, {
          method: "POST",
          body: JSON.stringify({ permissionMode: value.permissionMode }),
        })
      },
      async capabilities() {
        return (
          (await (await request("/api/session/capabilities", { method: "GET" })).json()) as {
            data: ServerSessionCapabilities
          }
        ).data
      },
      async archive(value: ServerSessionLifecycleInput) {
        await request(`/api/session/${encodeURIComponent(value.sessionID)}/archive`, { method: "POST" })
      },
      async restore(value: ServerSessionLifecycleInput) {
        await request(`/api/session/${encodeURIComponent(value.sessionID)}/restore`, { method: "POST" })
      },
      async remove(value: ServerSessionLifecycleInput) {
        await request(`/api/session/${encodeURIComponent(value.sessionID)}`, { method: "DELETE" })
      },
    },
  }
}

export type ServerApi = ReturnType<typeof createApiForServer>
