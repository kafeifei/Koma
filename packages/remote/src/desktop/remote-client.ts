import { ConnectionStatus, TunnelRelayTunnelClient } from "@microsoft/dev-tunnels-connections"
import type { Tunnel } from "@microsoft/dev-tunnels-contracts"
import type { TunnelManagementHttpClient } from "@microsoft/dev-tunnels-management"
import { getRemoteTunnel } from "@opencode-ai/remote/tunnels"
import type { RemoteTunnelDevice } from "@opencode-ai/remote/tunnels"
import type { Duplex } from "node:stream"
import { createWebEntry } from "./web-entry"

export type RemoteDeviceConnectionOptions = {
  management: TunnelManagementHttpClient
  id: string
  root: string
  clientOrigin: string
  preferredPort?: number
  signal?: AbortSignal
  onDisconnected?(): void
}

export type RemoteRelayClient = {
  readonly connectionStatus: ConnectionStatus
  acceptLocalConnectionsForForwardedPorts: boolean
  portForwarding(listener: (event: { readonly portNumber: number; cancel: boolean }) => void): { dispose(): void }
  connectionStatusChanged(listener: (event: { readonly status: ConnectionStatus }) => void): { dispose(): void }
  connect(tunnel: Tunnel): Promise<void>
  waitForForwardedPort(port: number): Promise<void>
  connectToForwardedPort(port: number): Promise<Duplex>
  dispose(): Promise<void>
}

export type RemoteClientFactory = {
  timeoutMs: number
  getTunnel(
    management: TunnelManagementHttpClient,
    id: string,
    tokenScopes: string[],
  ): Promise<{ device: RemoteTunnelDevice; tunnel: Tunnel }>
  createRelay(management: TunnelManagementHttpClient): RemoteRelayClient
}

export class RemoteClientError extends Error {
  constructor(public readonly code: "cancelled" | "invalid_device" | "timed_out") {
    super(`Remote device connection failed: ${code}`)
    this.name = "RemoteClientError"
  }
}

const factory: RemoteClientFactory = {
  timeoutMs: 60_000,
  getTunnel: getRemoteTunnel,
  createRelay: (management) => new TunnelRelayTunnelClient(management),
}
const preferredPorts = new Map<string, number>()

export async function connectRemoteDevice(options: RemoteDeviceConnectionOptions) {
  return connectRemoteDeviceWith(options, factory)
}

export function createRemoteDeviceConnector(dependencies: RemoteClientFactory) {
  return (options: RemoteDeviceConnectionOptions) => connectRemoteDeviceWith(options, dependencies)
}

async function connectRemoteDeviceWith(options: RemoteDeviceConnectionOptions, dependencies: RemoteClientFactory) {
  const startup = new AbortController()
  let gateway: ReturnType<typeof createWebEntry> | undefined
  let relay: RemoteRelayClient | undefined
  let forwardingSubscription: { dispose(): void } | undefined
  let statusSubscription: { dispose(): void } | undefined
  let stopping: Promise<void> | undefined
  let ready = false
  const timeout = setTimeout(() => startup.abort(new RemoteClientError("timed_out")), dependencies.timeoutMs)
  const abort = () => startup.abort(new RemoteClientError("cancelled"))
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()

  const stop = () => {
    if (stopping) return stopping
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abort)
    startup.signal.removeEventListener("abort", aborted)
    startup.abort(new RemoteClientError("cancelled"))
    ready = false
    forwardingSubscription?.dispose()
    statusSubscription?.dispose()
    stopping = Promise.allSettled([gateway?.stop(), relay?.dispose()]).then(() => undefined)
    return stopping
  }
  const aborted = () => {
    void stop()
  }
  startup.signal.addEventListener("abort", aborted, { once: true })

  try {
    const { device, tunnel } = await cancellable(
      dependencies.getTunnel(options.management, options.id, ["connect"]),
      startup.signal,
    )
    const origin = canonicalOrigin(device.url)
    if (!origin) throw new RemoteClientError("invalid_device")

    relay = dependencies.createRelay(options.management)
    relay.acceptLocalConnectionsForForwardedPorts = false
    forwardingSubscription = relay.portForwarding((event) => {
      if (event.portNumber !== device.port) event.cancel = true
    })
    statusSubscription = relay.connectionStatusChanged((event) => {
      if (!ready || event.status !== ConnectionStatus.Disconnected) return
      void stop()
        .then(() => options.onDisconnected?.())
        .catch(() => undefined)
    })
    await cancellable(relay.connect(tunnel), startup.signal)
    await cancellable(relay.waitForForwardedPort(device.port), startup.signal)

    const connectedRelay = relay
    gateway = createWebEntry({
      backend: async () => ({
        url: `http://${new URL(origin).host}`,
        origin,
        username: null,
        password: null,
        connect: () => connectedRelay.connectToForwardedPort(device.port),
      }),
      clientOrigin: options.clientOrigin,
      preferredPort: options.preferredPort ?? preferredPorts.get(options.id),
      root: options.root,
    })
    const entry = await cancellable(gateway.start(), startup.signal)
    if (connectedRelay.connectionStatus !== ConnectionStatus.Connected) {
      throw new Error("Remote relay disconnected during startup")
    }
    preferredPorts.set(options.id, Number(new URL(entry.url).port))
    clearTimeout(timeout)
    ready = true
    return { url: entry.url, name: device.name, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

function canonicalOrigin(value: string | null) {
  if (!value || !URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol === "https:" && url.origin === value && !url.username && !url.password) return value
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
