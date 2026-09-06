import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export type ServerPermissionMode = "default" | "auto" | "full"
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
  // The vendored client predates session permission modes. Remove this transport
  // extension when that client supports create.permissionMode and setPermissionMode.
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
    throw new Error(body?.data?.message ?? body?.message ?? `Request failed with status ${response.status}`)
  }

  return {
    ...client,
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
    },
  }
}

export type ServerApi = ReturnType<typeof createApiForServer>
