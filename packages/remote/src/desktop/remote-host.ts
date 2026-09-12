import { ConnectionStatus, TunnelRelayTunnelHost } from "@microsoft/dev-tunnels-connections"
import type { Tunnel, TunnelAccessControl } from "@microsoft/dev-tunnels-contracts"
import type { TunnelManagementHttpClient } from "@microsoft/dev-tunnels-management"
import { REMOTE_LABEL, REMOTE_PORT_LABEL, toRemoteDevice } from "@opencode-ai/remote/tunnels"
import { createWebEntry } from "./web-entry"

export type RemoteHostRecord = { clusterId: string; tunnelId: string; port: number }

type RemoteHostOptions = {
  management: TunnelManagementHttpClient
  backend: Parameters<typeof createWebEntry>[0]["backend"]
  root: string
  deviceID: string
  accountID: number
  name: string
  record?: RemoteHostRecord
  signal: AbortSignal
  save(record: RemoteHostRecord): void
  changed(status: "connecting" | "online" | "offline"): void
}

type RemoteHostDependencies = {
  createRelay?: (
    management: TunnelManagementHttpClient,
  ) => Pick<TunnelRelayTunnelHost, "connectionStatusChanged" | "connect" | "dispose">
}

export async function startRemoteHost(options: RemoteHostOptions, dependencies: RemoteHostDependencies = {}) {
  const lifecycle = { origin: undefined as string | undefined, ready: false, stopped: false }
  const gateway = createWebEntry({
    backend: options.backend,
    root: options.root,
    preferredPort: options.record?.port,
    remoteOrigin: () => lifecycle.origin,
  })
  const relay = dependencies.createRelay?.(options.management) ?? new TunnelRelayTunnelHost(options.management)
  const startup = new AbortController()
  const cancellation = {
    get isCancellationRequested() {
      return startup.signal.aborted
    },
    onCancellationRequested(
      listener: (event: unknown) => void,
      thisArgs?: unknown,
      disposables?: { dispose(): void }[],
    ) {
      const state = { disposed: false }
      const cancelled = () => {
        if (!state.disposed) listener.call(thisArgs, undefined)
      }
      const subscription = {
        dispose() {
          state.disposed = true
          startup.signal.removeEventListener("abort", cancelled)
        },
      }
      if (startup.signal.aborted) queueMicrotask(cancelled)
      startup.signal.addEventListener("abort", cancelled, { once: true })
      disposables?.push(subscription)
      return subscription
    },
  }
  const subscription = relay.connectionStatusChanged((event) => {
    if (lifecycle.stopped || !lifecycle.ready) return
    if (event.status === ConnectionStatus.Connected) return options.changed("online")
    if (event.status === ConnectionStatus.Disconnected) {
      void stop()
      return options.changed("offline")
    }
    options.changed("connecting")
  })
  let stopping: Promise<void> | undefined
  const stop = () => {
    if (stopping) return stopping
    lifecycle.stopped = true
    lifecycle.origin = undefined
    startup.abort()
    clearTimeout(timeout)
    subscription.dispose()
    options.signal.removeEventListener("abort", abort)
    // Stop the local gateway even if deleting the relay endpoint fails remotely.
    stopping = Promise.allSettled([
      Promise.resolve().then(() => gateway.stop()),
      Promise.resolve().then(() => relay.dispose()),
    ]).then(() => undefined)
    return stopping
  }
  // The connect cancellation token is only observed while the SDK connects. Keep
  // the external signal subscribed after readiness so it closes established streams.
  const abort = () => {
    void stop()
  }
  const timeout = setTimeout(abort, 60_000)
  options.signal.addEventListener("abort", abort, { once: true })
  if (options.signal.aborted) abort()

  try {
    startup.signal.throwIfAborted()
    const entry = await gateway.start()
    startup.signal.throwIfAborted()
    const port = Number(new URL(entry.url).port)
    // UUID separators would make this label 52 characters; the service allows 50.
    const label = `opencode-device-${options.deviceID.replaceAll("-", "")}`
    // Always recover from the owner-scoped directory. A saved ID or a product
    // label alone does not establish that the current account owns the tunnel.
    const candidates = await options.management.listTunnels(
      undefined,
      undefined,
      {
        labels: [REMOTE_LABEL, label],
        requireAllLabels: true,
        includePorts: true,
        includeAccessControl: true,
      },
      cancellation,
    )
    startup.signal.throwIfAborted()
    if (candidates.length > 1) throw new Error("Ambiguous remote device registration")
    const candidate = candidates[0]
    const previous = candidate
      ? await options.management
          .getTunnel(
            { clusterId: candidate.clusterId, tunnelId: candidate.tunnelId },
            {
              includePorts: true,
              includeAccessControl: true,
              tokenScopes: ["host", "manage"],
            },
            cancellation,
          )
          .catch((error: unknown) => {
            // SDK 1.3.56 getTunnel throws on HTTP 404 (despite its nullable return
            // type). Only a confirmed deletion permits a new registration.
            if (isNotFound(error)) return null
            throw error
          })
      : null
    startup.signal.throwIfAborted()
    if (previous) {
      if (previous.clusterId !== candidate?.clusterId || previous.tunnelId !== candidate?.tunnelId) {
        throw new Error("Remote device registration changed identity")
      }
      if (!previous.labels?.includes(REMOTE_LABEL) || !previous.labels.includes(label)) {
        throw new Error("Remote device registration does not match this computer")
      }
      const count = previous.status?.hostConnectionCount
      const hosts = typeof count === "number" ? count : count?.current
      if (typeof hosts !== "number" || !Number.isInteger(hosts) || hosts < 0) {
        throw new Error("Remote service did not confirm the device host state")
      }
      if (hosts > 0) {
        throw new Error("Remote device is already hosted by another instance")
      }
      requirePrivate(previous.accessControl, options.accountID)
      if (previous.ports?.some((item) => !item.labels?.includes(REMOTE_PORT_LABEL) || item.protocol !== "http")) {
        throw new Error("Remote device has an unexpected port")
      }
      previous.ports?.forEach((item) => requirePrivate(item.accessControl, options.accountID, true))
    }
    const metadata = {
      description: options.name,
      labels: [REMOTE_LABEL, label],
      options: { isHostHeaderUnchanged: true, isOriginHeaderUnchanged: true },
    }
    const tunnel: Tunnel = previous
      ? await options.management.updateTunnel(
          {
            tunnelId: previous.tunnelId,
            clusterId: previous.clusterId,
            ...metadata,
          },
          { tokenScopes: ["host", "manage"] },
          cancellation,
        )
      : await options.management.createTunnel(
          {
            ...metadata,
            accessControl: { entries: [] },
            ports: [{ portNumber: port, protocol: "http", labels: [REMOTE_PORT_LABEL] }],
          },
          { tokenScopes: ["host", "manage"] },
          cancellation,
        )
    startup.signal.throwIfAborted()
    if (!tunnel.clusterId || !tunnel.tunnelId) throw new Error("Remote service did not identify the tunnel")
    options.save({ clusterId: tunnel.clusterId, tunnelId: tunnel.tunnelId, port })
    if (previous) {
      // The profile owns this tunnel. Remove only its obsolete web port after a local port collision.
      for (const item of previous.ports ?? []) {
        if (item.portNumber !== port)
          await options.management.deleteTunnelPort(tunnel, item.portNumber, undefined, cancellation)
        startup.signal.throwIfAborted()
      }
      await options.management.createOrUpdateTunnelPort(
        tunnel,
        {
          portNumber: port,
          protocol: "http",
          labels: [REMOTE_PORT_LABEL],
          options: metadata.options,
        },
        undefined,
        cancellation,
      )
      startup.signal.throwIfAborted()
    }
    const resolved = await options.management.getTunnel(
      tunnel,
      {
        includePorts: true,
        includeAccessControl: true,
        tokenScopes: ["host"],
      },
      cancellation,
    )
    startup.signal.throwIfAborted()
    if (!resolved) throw new Error("Remote tunnel disappeared")
    requirePrivate(resolved.accessControl, options.accountID)
    resolved.ports?.forEach((item) => requirePrivate(item.accessControl, options.accountID, true))
    if (
      resolved.ports?.some(
        (item) =>
          (item.options?.isHostHeaderUnchanged ?? resolved.options?.isHostHeaderUnchanged) !== true ||
          (item.options?.isOriginHeaderUnchanged ?? resolved.options?.isOriginHeaderUnchanged) !== true,
      )
    )
      throw new Error("Remote service did not preserve the gateway origin boundary")
    const device = toRemoteDevice(resolved)
    if (!device?.url || device.port !== port) throw new Error("Remote service did not confirm the web endpoint")
    lifecycle.origin = new URL(device.url).origin
    await relay.connect(resolved, { enableRetry: true, enableReconnect: true }, cancellation)
    startup.signal.throwIfAborted()
    lifecycle.ready = true
    options.changed("online")
    startup.signal.throwIfAborted()
    return { device, stop }
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function requirePrivate(access: TunnelAccessControl | undefined, accountID: number, inheritsTunnel = false) {
  // An omitted port ACL adds no rules to the confirmed tunnel policy. An omitted
  // tunnel ACL is unknown: do not advertise it as a private, authenticated gateway.
  if (access === undefined && inheritsTunnel) return
  if (
    !Array.isArray(access?.entries) ||
    access.entries.some(
      (entry) =>
        !entry.isDeny &&
        !(
          !entry.isInverse &&
          entry.type === "Users" &&
          entry.provider?.toLowerCase() === "github" &&
          entry.subjects?.length &&
          entry.subjects.every((subject) => subject === String(accountID))
        ),
    )
  )
    throw new Error("Remote device access is not restricted to its owner")
}

function isNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "status" in error.response &&
    error.response.status === 404
  )
}
