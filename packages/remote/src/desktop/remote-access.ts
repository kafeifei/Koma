import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { createGitHubClient } from "@opencode-ai/remote/github"
import type { RemoteAccessState } from "./types"
import type { createWebEntry } from "./web-entry"
import type { RemoteControllerFailure } from "./remote-controller"
import { createRemoteController } from "./remote-controller"

export function createRemoteAccess(options: {
  credentials: Parameters<typeof createRemoteController>[0]["credentials"]
  settings: { get(key: string): unknown; set(key: string, value: unknown): void }
  fetch?: typeof fetch
  website?: string
  deviceName?: string
  backend: Parameters<typeof createWebEntry>[0]["backend"]
  root: string
  clientOrigin: string
  changed(state: RemoteAccessState): void
  failed?(failure: RemoteControllerFailure): void
}) {
  const settings = options.settings
  const github = createGitHubClient({ fetch: options.fetch ?? fetch })
  const saved = settings.get("remoteDeviceID")
  const deviceID = typeof saved === "string" && /^[a-f0-9-]{36}$/.test(saved) ? saved : randomUUID()
  settings.set("remoteDeviceID", deviceID)
  const website = options.website || "https://opencode-lab-remote.vercel.app/"
  const url = website ? URL.parse(website) : null
  return createRemoteController({
    credentials: options.credentials,
    settings,
    deviceID,
    deviceName: (options.deviceName ?? hostname()).slice(0, 40),
    website:
      url &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
        ? url.href
        : null,
    changed: options.changed,
    failed: options.failed,
    login: github.beginGitHubLogin,
    waitLogin: github.waitGitHubLogin,
    account: github.getGitHubAccount,
    refreshCredential: github.refreshGitHubCredential,
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
