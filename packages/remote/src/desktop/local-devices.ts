import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { RemoteAccessState } from "./types"

type Settings = { get(key: string): unknown }

/** Local host registrations are shared identity evidence; listener ports still belong to one host. */
export function localRemoteDevices(settings: Settings, profile?: string) {
  const read = (file: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(file, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error
    }
  }
  const values: Record<string, unknown>[] = []
  if (profile) {
    values.push(read(join(profile, "desktop", "opencode.settings")))
    const instances = join(profile, "bin", ".koma-instances")
    let names: string[] = []
    try {
      names = readdirSync(instances, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    for (const name of names) values.push(read(join(instances, name, "desktop", "settings.json")))
  }
  // In-memory settings take precedence for the calling host.
  values.push(
    Object.fromEntries(["remoteDeviceID", "remoteTunnels", "remoteClientPorts"].map((key) => [key, settings.get(key)])),
  )
  const hosts = new Map(
    values.flatMap((value) =>
      typeof value.remoteDeviceID === "string" ? [[value.remoteDeviceID, value] as const] : [],
    ),
  )
  const ids = new Set<string>()
  for (const host of hosts.values()) {
    for (const record of Object.values(object(host.remoteTunnels))) {
      const value = object(record)
      if (typeof value.clusterId === "string" && typeof value.tunnelId === "string")
        ids.add(`${value.clusterId}/${value.tunnelId}`)
    }
  }
  const connections: NonNullable<RemoteAccessState["connections"]> = []
  for (const [clientID, host] of hosts) {
    for (const [id, port] of Object.entries(object(host.remoteClientPorts))) {
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) continue
      connections.push({ id, clientID, url: `http://127.0.0.1:${port}`, current: ids.has(id) })
    }
  }
  return { ids, connections }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
