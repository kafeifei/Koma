import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { DesktopStoreRequest } from "@opencode-ai/core/koma-desktop-store"
import { createDesktopStorage } from "./storage"

const name = "opencode.global.dat"
const key = "server"
const fields = ["projects", "lastProject", "recentlyClosed"] as const

function record(raw: string | null): Record<string, any> {
  if (raw === null) return {}
  const value = JSON.parse(raw)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project storage")
  return value
}

/** Copy only navigation for the backend serving this page. Connections and other host scopes stay client-owned. */
function projectState(base: string | null, source: string | null) {
  const value = record(base)
  const incoming = record(source)
  for (const field of fields) {
    value[field] = { ...value[field] }
    if (incoming[field]?.local !== undefined) value[field].local = incoming[field].local
    else delete value[field].local
  }
  return JSON.stringify(value)
}

export async function createWebProjectStorage(
  call: (request: DesktopStoreRequest) => Promise<unknown>,
  local: (name?: string) => SyncStorage,
  pollIntervalMs = 1_000,
) {
  // Observe just the shared project record, without loading desktop window state or preferences.
  const shared = createDesktopStorage(async (request) => {
    if (request.op !== "read") return call(request)
    const value = (await call({ op: "get", name, key })) as string | null
    return { [name]: value === null ? {} : { [key]: value } }
  }, pollIntervalMs)
  const backend = shared.storage(name)
  let snapshot: string | null
  try {
    snapshot = (await backend.getItem(key)) ?? null
    record(snapshot)
  } catch (error) {
    shared.dispose()
    throw error
  }
  const browser = local(name)
  const read = () => (snapshot === null ? browser.getItem(key) : projectState(browser.getItem(key), snapshot))
  const listeners = new Set<(change: { key: string; newValue: string | null }) => void>()
  shared.observeStorage(name, (change) => {
    if (change.key !== key) return
    snapshot = change.newValue
    const event = { key, newValue: read() }
    listeners.forEach((notify) => notify(event))
  })
  const write = (value: string | null) => {
    if (value === null) browser.removeItem(key)
    else browser.setItem(key, value)
    // The desktop adapter retains the last-read base for the backend's atomic three-way merge.
    // Never read a newer base immediately before applying potentially stale browser state.
    snapshot = projectState(snapshot, value)
    return backend.setItem(key, snapshot)
  }
  const storage: AsyncStorage = {
    async getItem(item) {
      if (item !== key) return browser.getItem(item)
      snapshot = (await backend.getItem(key)) ?? null
      return read()
    },
    async setItem(item, value) {
      if (item !== key) return browser.setItem(item, value)
      await write(value)
    },
    async removeItem(item) {
      if (item !== key) return browser.removeItem(item)
      await write(null)
    },
  }
  return {
    storage: (store?: string) => (store === name ? storage : local(store)),
    observeStorage(store: string | undefined, notify: (change: { key: string; newValue: string | null }) => void) {
      if (store !== name) return () => {}
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    dispose() {
      shared.dispose()
      listeners.clear()
    },
  }
}
