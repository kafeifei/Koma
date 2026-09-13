import { TunnelConstraints, type Tunnel } from "@microsoft/dev-tunnels-contracts"
import type { TunnelManagementClient } from "@microsoft/dev-tunnels-management"
import { REMOTE_LABEL, toRemoteDevice } from "../tunnels"

export type RemoteRegistration = {
  id: string
  name: string
  online: boolean | null
  connectable?: boolean
  deviceLabel?: string
}
export type RemoteQuota = { current: number; limit: number }
export type RemoteRemovalStatus = "deleted" | "missing" | "protected" | "online" | "unknown" | "failed"
type DirectoryClient = Pick<TunnelManagementClient, "listTunnels" | "getTunnel">

function identity(id: string) {
  const [clusterId, tunnelId, extra] = id.split("/")
  if (
    extra !== undefined ||
    !clusterId ||
    !tunnelId ||
    !TunnelConstraints.clusterIdRegex.test(clusterId) ||
    !new RegExp(`^(?:${TunnelConstraints.oldTunnelIdPattern}|${TunnelConstraints.newTunnelIdPattern})$`).test(tunnelId)
  )
    throw new Error("Invalid remote device")
  return { clusterId, tunnelId }
}

function project(tunnel: Tunnel): RemoteRegistration | undefined {
  if (!Array.isArray(tunnel.labels) || !tunnel.labels.includes(REMOTE_LABEL)) return
  const id = `${tunnel.clusterId}/${tunnel.tunnelId}`
  try {
    identity(id)
  } catch {
    return
  }
  const count = tunnel.status?.hostConnectionCount
  const hosts = typeof count === "number" ? count : count?.current
  return {
    id,
    name: tunnel.description?.trim() || tunnel.name || tunnel.tunnelId!,
    online: typeof hosts === "number" && Number.isInteger(hosts) && hosts >= 0 ? hosts > 0 : null,
    connectable: !!toRemoteDevice(tunnel),
    deviceLabel: tunnel.labels.find((label) => /^opencode-device-[a-f0-9]{32}$/i.test(label)),
  }
}

async function owned(client: DirectoryClient) {
  const tunnels = await client.listTunnels(undefined, undefined, { labels: [REMOTE_LABEL] })
  if (!Array.isArray(tunnels)) throw new Error("Remote directory unavailable")
  return [
    ...new Map(
      tunnels.flatMap((tunnel) => {
        const entry = tunnel && project(tunnel)
        return entry ? [[entry.id, identity(entry.id)] as const] : []
      }),
    ).values(),
  ]
}

function missing(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as { status?: number; statusCode?: number; response?: { status?: number } }
  return (value.status ?? value.statusCode ?? value.response?.status) === 404
}

async function detail(client: DirectoryClient, ref: ReturnType<typeof identity>) {
  const tunnel = await client.getTunnel(ref, { includePorts: true }).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (tunnel && (tunnel.clusterId !== ref.clusterId || tunnel.tunnelId !== ref.tunnelId)) {
    throw new Error("Remote device identity changed")
  }
  return tunnel
}

/** Includes incomplete product registrations for cleanup, without relaxing connection validation. */
export async function listRemoteRegistrations(client: DirectoryClient): Promise<RemoteRegistration[]> {
  try {
    const refs = await owned(client)
    const entries = await Promise.all(
      refs.map(async (ref) => {
        const tunnel = await detail(client, ref)
        return tunnel ? project(tunnel) : undefined
      }),
    )
    return entries.filter((entry) => entry !== undefined)
  } catch {
    // Never let an SDK error carrying credentials cross the desktop boundary.
    throw new Error("Remote directory unavailable")
  }
}

export async function removeRemoteRegistration(
  client: DirectoryClient & Pick<TunnelManagementClient, "deleteTunnel">,
  id: string,
  guard: { deviceID: string; currentID?: string; check(): void },
): Promise<RemoteRemovalStatus> {
  try {
    const ref = identity(id)
    guard.check()
    if (id === guard.currentID) return "protected"
    const refs = await owned(client)
    guard.check()
    if (!refs.some((item) => item.clusterId === ref.clusterId && item.tunnelId === ref.tunnelId)) return "missing"
    const tunnel = await detail(client, ref)
    guard.check()
    if (!tunnel) return "missing"
    const entry = project(tunnel)
    if (!entry) return "protected"
    // Protect this profile even when its saved tunnel locator was lost or replaced.
    if (tunnel.labels?.includes(`opencode-device-${guard.deviceID.replaceAll("-", "")}`)) return "protected"
    if (entry.online === true) return "online"
    if (entry.online !== false) return "unknown"
    guard.check()
    // The SDK offers no conditional host-count delete. Recheck immediately before dispatch;
    // do not infer offline from absent metadata or delete an unverified directory row.
    return (await client.deleteTunnel(ref)) ? "deleted" : "missing"
  } catch (error) {
    return missing(error) ? "missing" : "failed"
  }
}

export async function getRemoteQuota(
  client: Pick<TunnelManagementClient, "listUserLimits">,
): Promise<RemoteQuota | null> {
  try {
    const limits = await client.listUserLimits()
    // Service quota name also used by Microsoft's VS Code tunnel client.
    const entries = limits.filter((entry) => entry.name === "TunnelsPerUserPerLocation")
    if (entries.length !== 1) return null
    const { current, limit } = entries[0]!
    return typeof current === "number" &&
      Number.isSafeInteger(current) &&
      current >= 0 &&
      typeof limit === "number" &&
      Number.isSafeInteger(limit) &&
      limit > 0
      ? { current, limit }
      : null
  } catch {
    return null
  }
}
