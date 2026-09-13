import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

const Plugin = Schema.Struct({
  id: Schema.String,
  spec: Schema.String,
  version: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  options: Schema.Record(Schema.String, Schema.Unknown),
})
export type Plugin = typeof Plugin.Type
const Store = Schema.Struct({
  version: Schema.Literal(1),
  plugins: Schema.Array(Plugin),
  integrations: Schema.Record(Schema.String, Schema.Record(Schema.String, ConfigMCPV1.Info)),
})
export type Store = typeof Store.Type

export function storeFile() {
  return path.join(Global.Path.config, "koma-extensions.json")
}

export async function readStore(file = storeFile()): Promise<Store> {
  const text = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return { version: 1, plugins: [], integrations: {} }
  // A broken registry must never be silently replaced with an empty one.
  return Schema.decodeUnknownSync(Store)(JSON.parse(text))
}

export async function updateStore(update: (store: Store) => Store, file = storeFile()) {
  return Flock.withLock(`koma-extensions:${file}`, async () => {
    const next = Schema.decodeUnknownSync(Store)(update(await readStore(file)))
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return next
  })
}

export async function integrations(directory: string) {
  return (await readStore()).integrations[directory] ?? {}
}

export function fingerprint(plugin: Pick<Plugin, "spec" | "options">) {
  return JSON.stringify([plugin.spec, plugin.options])
}
