import npa from "npm-package-arg"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { PluginInfo, PluginRuntime } from "@opencode-ai/schema/koma-extensions"
import { PluginLoader } from "@/plugin/loader"
import { parsePluginSpecifier, isDeprecatedPlugin } from "@/plugin/shared"
import { readStore, updateStore, fingerprint, type Plugin } from "./store"

// Observations only. Desired state lives in the registry; runtime ownership stays
// with each Plugin InstanceState and is removed by its scope finalizer.
const runtimes = new Map<string, Map<string, PluginRuntime & { spec: string; managed: boolean }>>()

export function observe(directory: string) {
  const rows = new Map<string, PluginRuntime & { spec: string; managed: boolean }>()
  runtimes.set(directory, rows)
  return {
    set(
      spec: string,
      managed: boolean,
      options: Record<string, unknown>,
      status: PluginRuntime["status"],
      error?: string,
    ) {
      rows.set(identity(spec), {
        spec,
        managed,
        directory,
        fingerprint: fingerprint({ spec, options }),
        status,
        ...(error ? { error } : {}),
      })
    },
    dispose() {
      if (runtimes.get(directory) === rows) runtimes.delete(directory)
    },
  }
}

export function identity(spec: string) {
  return spec.startsWith("file://") ? spec : parsePluginSpecifier(spec).pkg
}

export async function listPlugins(): Promise<PluginInfo[]> {
  const store = await readStore()
  const rows = new Map<string, PluginInfo>(
    store.plugins.map((p) => [
      p.id,
      {
        ...p,
        installed: true,
        managed: true,
        pending: false,
        runtime: [],
      },
    ]),
  )
  for (const directory of runtimes.values()) {
    for (const [id, runtime] of directory) {
      const row = rows.get(id) ?? {
        id,
        spec: runtime.spec,
        options: {},
        installed: !runtime.managed,
        enabled: !runtime.managed,
        managed: runtime.managed,
        pending: false,
        runtime: [],
      }
      rows.set(id, { ...row, runtime: [...row.runtime, runtime] })
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      pending:
        row.managed &&
        (row.enabled
          ? !row.runtime.length ||
            [...runtimes.values()].some((r) => !r.has(row.id)) ||
            row.runtime.some((r) => r.fingerprint !== fingerprint(row))
          : row.runtime.some((r) => r.status === "active" || r.status === "loading")),
    }))
    .filter((row) => row.installed || row.runtime.some((r) => r.status === "active" || r.status === "loading"))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function installPlugin(input: { spec: string; options: Record<string, unknown> }) {
  let spec = input.spec.trim()
  if (!spec || spec.length > 500) throw new Error("Enter an npm package or an absolute local plugin path.")
  if (path.isAbsolute(spec)) spec = pathToFileURL(spec).href
  if (!spec.startsWith("file://")) {
    const parsed = npa(spec)
    if (!parsed.name || !["tag", "version", "range"].includes(parsed.type)) {
      throw new Error("Only npm packages and absolute local plugin paths are supported.")
    }
  }
  if (isDeprecatedPlugin(spec)) throw new Error("This plugin is already built into the backend.")
  const resolved = await PluginLoader.resolve({ spec, options: input.options, deprecated: false }, "server")
  if (!resolved.ok) throw new Error(resolved.stage === "missing" ? resolved.value.message : String(resolved.error))
  // Resolve and pin the installed version without importing or running its code.
  const version = resolved.value.pkg?.json.version
  if (resolved.value.source === "npm" && typeof version === "string") spec = `${identity(spec)}@${version}`
  const plugin: Plugin = {
    id: identity(spec),
    spec,
    options: input.options,
    enabled: true,
    ...(typeof version === "string" ? { version } : {}),
  }
  await updateStore((store) => {
    if (store.plugins.some((p) => p.id === plugin.id)) throw new Error("Plugin is already installed.")
    if ([...runtimes.values()].some((r) => r.get(plugin.id)?.managed === false)) {
      throw new Error("This plugin is managed by an existing configuration file.")
    }
    return { ...store, plugins: [...store.plugins, plugin] }
  })
}

export async function changePlugin(id: string, change?: { enabled: boolean; options?: Record<string, unknown> }) {
  await updateStore((store) => {
    if (!store.plugins.some((p) => p.id === id)) throw new Error("Managed plugin not found.")
    return {
      ...store,
      plugins: change
        ? store.plugins.map((p) => (p.id === id ? { ...p, ...change } : p))
        : store.plugins.filter((p) => p.id !== id),
    }
  })
}
