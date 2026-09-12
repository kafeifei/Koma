import type { AsyncStorage } from "@solid-primitives/storage"
import type { DesktopStoreRequest } from "@opencode-ai/core/koma-desktop-store"

type Change = { key: string; newValue: string | null }
type Call = (request: DesktopStoreRequest) => Promise<unknown>

/** The same storage and change delivery adapter is used by both desktop hosts. */
export function createDesktopStorage(call: Call, pollIntervalMs = 1_000) {
  const cache = new Map<string, Map<string, string | null>>()
  const listeners = new Map<string, Set<(change: Change) => void>>()
  const writes = new Map<string, Promise<unknown>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let refreshing = false
  const values = (name: string) => {
    if (!cache.has(name)) cache.set(name, new Map())
    return cache.get(name)!
  }
  const publish = (name: string, key: string, value: string | null) => {
    const previous = values(name).get(key)
    values(name).set(key, value)
    if (value !== previous) listeners.get(name)?.forEach((listen) => listen({ key, newValue: value }))
  }
  const refresh = async () => {
    if (closed || !listeners.size || refreshing) return
    refreshing = true
    timer = undefined
    try {
      const names = [...listeners.keys()]
      const snapshot: Record<string, Record<string, string>> = {}
      for (let offset = 0; offset < names.length; offset += 100)
        Object.assign(snapshot, await call({ op: "read", names: names.slice(offset, offset + 100) }))
      for (const name of names)
        for (const key of new Set([...values(name).keys(), ...Object.keys(snapshot[name] ?? {})])) {
          if (!writes.has(`${name}\0${key}`)) publish(name, key, snapshot[name]?.[key] ?? null)
        }
    } finally {
      refreshing = false
      if (!closed && listeners.size) timer = setTimeout(() => void refresh().catch(console.error), pollIntervalMs)
    }
  }
  const observeStorage = (name = "default.dat", listen: (change: Change) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(listen)
    if (!timer && !refreshing) timer = setTimeout(() => void refresh().catch(console.error), pollIntervalMs)
    return () => {
      listeners.get(name)?.delete(listen)
      if (!listeners.get(name)?.size) listeners.delete(name)
      if (!listeners.size) {
        clearTimeout(timer)
        timer = undefined
      }
    }
  }
  const storage = (name = "default.dat"): AsyncStorage => ({
    async getItem(key) {
      const id = `${name}\0${key}`
      await writes.get(id)?.catch(() => undefined)
      const value = (await call({ op: "get", name, key })) as string | null
      if (!writes.has(id)) values(name).set(key, value)
      return value
    },
    async setItem(key, value) {
      const id = `${name}\0${key}`
      const base = values(name).get(key)
      values(name).set(key, value)
      const next = (writes.get(id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const stored = (await call({ op: "set", name, key, value, base })) as string
          if (writes.get(id) !== next) return
          values(name).set(key, stored)
          if (stored !== value) listeners.get(name)?.forEach((listen) => listen({ key, newValue: stored }))
        })
      writes.set(id, next)
      try {
        await next
      } finally {
        if (writes.get(id) === next) writes.delete(id)
      }
    },
    async removeItem(key) {
      await writes.get(`${name}\0${key}`)?.catch(() => undefined)
      await call({ op: "remove", name, key })
      publish(name, key, null)
    },
    async clear() {
      await Promise.allSettled(
        [...writes.entries()].filter(([id]) => id.startsWith(`${name}\0`)).map(([, write]) => write),
      )
      await call({ op: "clear", name })
      for (const key of values(name).keys()) publish(name, key, null)
    },
    async key(index: number) {
      return ((await call({ op: "keys", name })) as string[])[index]
    },
    async getLength() {
      return ((await call({ op: "keys", name })) as string[]).length
    },
  })
  return {
    storage,
    observeStorage,
    dispose() {
      closed = true
      clearTimeout(timer)
      listeners.clear()
    },
  }
}
