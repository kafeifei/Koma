import { TunnelConstraints } from "@microsoft/dev-tunnels-contracts"
import type { Tunnel } from "@microsoft/dev-tunnels-contracts"
import { ManagementApiVersions, TunnelManagementHttpClient } from "@microsoft/dev-tunnels-management"
import type { TunnelManagementClient } from "@microsoft/dev-tunnels-management"

export const REMOTE_LABEL = "opencode-lab-remote-v1"
export const REMOTE_PORT_LABEL = "opencode-lab-web-v1"

export type RemoteTunnelDevice = {
  id: string
  name: string
  online: boolean | null
  url: string | null
  port: number
  clusterId: string
  tunnelId: string
}

export class RemoteTunnelError extends Error {
  constructor(public readonly code: "invalid_id" | "not_found" | "invalid_tunnel" | "request_failed") {
    // SDK errors may contain request headers and credential-bearing config objects.
    super(`Remote tunnel request failed: ${code}`)
    this.name = "RemoteTunnelError"
  }
}

export function createTunnelManagement(getToken: () => Promise<string>) {
  return new TunnelManagementHttpClient(
    { name: "Koma", version: "1.0" },
    ManagementApiVersions.Version20230927preview,
    async () => {
      const token = await getToken()
      if (!token || /[\s\u0000-\u001f\u007f]/.test(token)) throw new RemoteTunnelError("request_failed")
      return `github ${token}`
    },
  )
}

/** Projects service metadata into a credential-free directory entry. */
export function toRemoteDevice(tunnel: Tunnel): RemoteTunnelDevice | undefined {
  if (!tunnel || !Array.isArray(tunnel.labels) || !tunnel.labels.includes(REMOTE_LABEL)) return
  if (!validIdentity(tunnel.clusterId, tunnel.tunnelId) || !Array.isArray(tunnel.ports) || tunnel.ports.length !== 1)
    return
  const port = tunnel.ports[0]
  if (
    !port ||
    !Array.isArray(port.labels) ||
    !port.labels.includes(REMOTE_PORT_LABEL) ||
    port.protocol !== "http" ||
    !Number.isInteger(port.portNumber) ||
    port.portNumber < 1 ||
    port.portNumber > 65535 ||
    (port.clusterId !== undefined && port.clusterId !== tunnel.clusterId) ||
    (port.tunnelId !== undefined && port.tunnelId !== tunnel.tunnelId)
  )
    return
  const clusterId = tunnel.clusterId!
  const tunnelId = tunnel.tunnelId!
  const count = tunnel.status?.hostConnectionCount
  const hosts = typeof count === "number" ? count : count?.current
  return {
    id: `${clusterId}/${tunnelId}`,
    name:
      (typeof tunnel.description === "string" && tunnel.description.trim()) ||
      (typeof tunnel.name === "string" && tunnel.name) ||
      tunnelId,
    online: typeof hosts === "number" && Number.isInteger(hosts) && hosts >= 0 ? hosts > 0 : null,
    url: Array.isArray(port.portForwardingUris)
      ? (port.portForwardingUris.map(publicOrigin).find((uri) => uri !== null) ?? null)
      : null,
    port: port.portNumber,
    clusterId,
    tunnelId,
  }
}

export async function listRemoteDevices(client: Pick<TunnelManagementClient, "listTunnels" | "getTunnel">) {
  const tunnels = await client
    .listTunnels(undefined, undefined, {
      labels: [REMOTE_LABEL],
    })
    .catch(() => {
      throw new RemoteTunnelError("request_failed")
    })
  if (!Array.isArray(tunnels)) throw new RemoteTunnelError("invalid_tunnel")
  // Global listings omit ports even with includePorts. Use the owner-scoped
  // directory only for identity discovery, then validate each complete detail.
  const candidates = tunnels.filter(
    (tunnel) =>
      Array.isArray(tunnel?.labels) &&
      tunnel.labels.includes(REMOTE_LABEL) &&
      validIdentity(tunnel.clusterId, tunnel.tunnelId),
  )
  const devices = await Promise.all(
    [...new Map(candidates.map((tunnel) => [`${tunnel.clusterId}/${tunnel.tunnelId}`, tunnel])).values()].map(
      async (candidate) => {
        const tunnel = await client
          .getTunnel({ clusterId: candidate.clusterId, tunnelId: candidate.tunnelId }, { includePorts: true })
          .catch(() => {
            throw new RemoteTunnelError("request_failed")
          })
        if (!tunnel) return
        if (tunnel.clusterId !== candidate.clusterId || tunnel.tunnelId !== candidate.tunnelId) {
          throw new RemoteTunnelError("invalid_tunnel")
        }
        return toRemoteDevice(tunnel)
      },
    ),
  )
  return devices.filter((device) => device !== undefined)
}

/** Fetches only a labelled, single-port tunnel owned by the current account. */
export async function getRemoteTunnel(
  client: Pick<TunnelManagementClient, "listTunnels" | "getTunnel">,
  id: string,
  tokenScopes?: string[],
) {
  const parts = id.split("/")
  if (parts.length !== 2 || !validIdentity(parts[0], parts[1])) throw new RemoteTunnelError("invalid_id")
  // Labels identify the product, not an owner. The management list is owner-scoped;
  // checking it first prevents a supplied ID from selecting someone else's tunnel.
  const owned = (await listRemoteDevices(client)).find((device) => device.id === id)
  if (!owned) throw new RemoteTunnelError("not_found")
  const tunnel = await client
    .getTunnel({ clusterId: owned.clusterId, tunnelId: owned.tunnelId }, { includePorts: true, tokenScopes })
    .catch(() => {
      throw new RemoteTunnelError("request_failed")
    })
  if (!tunnel) throw new RemoteTunnelError("not_found")
  const device = toRemoteDevice(tunnel)
  if (!device || device.id !== id) throw new RemoteTunnelError("invalid_tunnel")
  // Keep raw SDK data on the trusted Node side. Only `device` belongs in UI responses.
  return { device, tunnel }
}

function validIdentity(clusterId: string | undefined, tunnelId: string | undefined) {
  if (typeof clusterId !== "string" || typeof tunnelId !== "string") return false
  return (
    TunnelConstraints.clusterIdRegex.test(clusterId) &&
    new RegExp(`^(?:${TunnelConstraints.oldTunnelIdPattern}|${TunnelConstraints.newTunnelIdPattern})$`).test(tunnelId)
  )
}

function publicOrigin(value: string): string | null {
  if (typeof value !== "string" || !URL.canParse(value)) return null
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".devtunnels.ms") ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return null
  return url.origin
}
