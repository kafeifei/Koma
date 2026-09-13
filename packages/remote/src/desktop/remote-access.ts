import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { createGitHubClient } from "@opencode-ai/remote/github"
import type { RemoteAccessState } from "./types"
import type { createWebEntry } from "./web-entry"
import type { RemoteControllerFailure } from "./remote-controller"
import { createRemoteController } from "./remote-controller"
import { localRemoteDevices } from "./local-devices"

export function createRemoteAccess(options: {
  credentials: Parameters<typeof createRemoteController>[0]["credentials"]
  settings: { get(key: string): unknown; set(key: string, value: unknown): void }
  fetch?: typeof fetch
  website?: string
  deviceName?: string
  backend: Parameters<typeof createWebEntry>[0]["backend"]
  root: string
  profile?: string
  clientOrigin: string
  changed(state: RemoteAccessState): void
  failed?(failure: RemoteControllerFailure): void
}) {
  const settings = options.settings
  const github = createGitHubClient({ fetch: options.fetch ?? fetch })
  const saved = settings.get("remoteDeviceID")
  const deviceID = typeof saved === "string" && /^[a-f0-9-]{36}$/.test(saved) ? saved : randomUUID()
  settings.set("remoteDeviceID", deviceID)
  const website = options.website || "https://koma-remote.vercel.app/"
  const url = website ? URL.parse(website) : null
  const local = () => localRemoteDevices(settings, options.profile)
  const controller = createRemoteController({
    credentials: options.credentials,
    settings,
    deviceID,
    isCurrent: (id) => local().ids.has(id),
    connections: () => local().connections,
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
      const { createTunnelManagement } = await import("@opencode-ai/remote/tunnels")
      const { listRemoteRegistrations } = await import("./remote-registrations")
      return listRemoteRegistrations(createTunnelManagement(token))
    },
    quota: async (token) => {
      const { createTunnelManagement } = await import("@opencode-ai/remote/tunnels")
      const { getRemoteQuota } = await import("./remote-registrations")
      return getRemoteQuota(createTunnelManagement(token))
    },
    remove: async (token, id, guard) => {
      const { createTunnelManagement } = await import("@opencode-ai/remote/tunnels")
      const { removeRemoteRegistration } = await import("./remote-registrations")
      return removeRemoteRegistration(createTunnelManagement(token), id, guard)
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
  return {
    ...controller,
    connect: async (id: string) => ({ ...(await controller.connect(id)), remote: { id, clientID: deviceID } }),
  }
}
