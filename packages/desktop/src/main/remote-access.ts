import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { safeStorage } from "electron"
import type { RemoteAccessState } from "@opencode-ai/app/remote-access"
import type { createWebEntry } from "./web-entry"
import { createRemoteController } from "./remote-controller"
import { createRemoteCredentials } from "./remote-credentials"
import { getStore } from "./store"

export function createRemoteAccess(options: {
  backend: Parameters<typeof createWebEntry>[0]["backend"]
  root: string
  clientOrigin: string
  changed(state: RemoteAccessState): void
}) {
  const settings = getStore()
  const saved = settings.get("remoteDeviceID")
  const deviceID = typeof saved === "string" && /^[a-f0-9-]{36}$/.test(saved) ? saved : randomUUID()
  settings.set("remoteDeviceID", deviceID)
  const website = process.env.OPENCODE_REMOTE_WEBSITE || import.meta.env.OPENCODE_REMOTE_WEBSITE
  const url = website ? URL.parse(website) : null
  return createRemoteController({
    credentials: createRemoteCredentials({ storage: safeStorage, store: settings }),
    settings,
    deviceID,
    deviceName: hostname().slice(0, 40),
    website:
      url &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
        ? url.href
        : null,
    changed: options.changed,
    login: async (input) => {
      const { beginGitHubLogin } = await import("@opencode-ai/remote/github")
      return beginGitHubLogin(input)
    },
    waitLogin: async (authorization, input) => {
      const { waitGitHubLogin } = await import("@opencode-ai/remote/github")
      return waitGitHubLogin(authorization, input)
    },
    account: async (token) => {
      const { getGitHubAccount } = await import("@opencode-ai/remote/github")
      return getGitHubAccount(token)
    },
    refreshCredential: async (credential) => {
      const { refreshGitHubCredential } = await import("@opencode-ai/remote/github")
      return refreshGitHubCredential(credential)
    },
    list: async (token) => {
      const { createTunnelManagement, listRemoteDevices } = await import("@opencode-ai/remote/tunnels")
      return listRemoteDevices(createTunnelManagement(token))
    },
    host: async (input) => {
      const { createTunnelManagement } = await import("@opencode-ai/remote/tunnels")
      const { startRemoteHost } = await import("./remote-host")
      return startRemoteHost({
        ...input,
        management: createTunnelManagement(input.token),
        backend: options.backend,
        root: options.root,
      })
    },
    connect: async (token, id, signal, disconnected) => {
      const { createTunnelManagement } = await import("@opencode-ai/remote/tunnels")
      const { connectRemoteDevice } = await import("./remote-client")
      const stored = settings.get("remoteClientPorts")
      const ports = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}
      const preferredPort = Reflect.get(ports, id)
      const connection = await connectRemoteDevice({
        management: createTunnelManagement(token),
        id,
        root: options.root,
        clientOrigin: options.clientOrigin,
        preferredPort: typeof preferredPort === "number" ? preferredPort : undefined,
        signal,
        onDisconnected: disconnected,
      })
      try {
        // Preserve the existing server URL (and its local drafts) across client restarts
        // when the previously allocated loopback port is still available.
        settings.set("remoteClientPorts", { ...ports, [id]: Number(new URL(connection.url).port) })
      } catch (error) {
        await connection.stop()
        throw error
      }
      return connection
    },
  })
}
