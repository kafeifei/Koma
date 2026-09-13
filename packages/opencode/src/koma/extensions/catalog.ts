import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { parse as parseJSONC, type ParseError } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import type { CatalogEntry, ExtensionCatalog } from "@opencode-ai/schema/koma-extensions"
import snapshot from "./catalog.snapshot.json"
import translations from "./catalog.translations.json"
import { recipes } from "./recipes"

export const catalogSources = {
  ecosystem: "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/ecosystem.mdx",
  mcp: "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/mcp-servers.mdx",
}
const docs = "https://opencode.ai/docs/"
const maxBytes = 512 * 1024
type CatalogFetch = (url: string, options: RequestInit) => Promise<Response>
const headings: Record<string, "plugin" | "project" | "agent"> = {
  Plugins: "plugin",
  Projects: "project",
  Agents: "agent",
}
const translated: Record<string, { original: string; zh: string }> = translations
const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  fetchedAt: Schema.String,
  ecosystem: Schema.String,
  mcp: Schema.String,
})

function webUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid resource URL in official directory")
  return url.href.replace(/\/$/, "")
}

function plain(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .trim()
}

export function parseCatalog(ecosystem: string, mcp: string): CatalogEntry[] {
  if (ecosystem.length > maxBytes || mcp.length > maxBytes) throw new Error("Official directory is too large")
  const entries = new Map<string, CatalogEntry>()
  let kind: "plugin" | "project" | "agent" | undefined
  for (const line of ecosystem.split("\n")) {
    if (line.startsWith("## ")) kind = headings[line.slice(3).trim()]
    if (!kind) continue
    const row = line.match(/^\|\s*\[([^\]]+)\]\(([^\s)]+)\)\s*\|\s*(.*?)\s*\|\s*$/)
    if (!row) {
      if (/^\|\s*\[/.test(line)) throw new Error("Official resource row format changed")
      continue
    }
    const url = webUrl(row[2])
    const id = `${kind}:${url}`
    const recipe = kind === "plugin" ? recipes[url] : undefined
    entries.set(id, {
      id,
      kind,
      name: plain(row[1]),
      description: plain(row[3]),
      // A changed upstream description falls back to its current original text.
      ...(translated[url]?.original === row[3].trim() ? { descriptionZh: plain(translated[url].zh) } : {}),
      url,
      sourceUrl: `${docs}ecosystem/#${kind === "plugin" ? "plugins" : kind === "project" ? "projects" : "agents"}`,
      ...(recipe?.type === "npm" ? { plugin: { spec: recipe.spec, verifiedAt: recipe.verifiedAt } } : {}),
      ...(recipe
        ? {
            installation: {
              type: recipe.type === "files" && !recipe.entry ? ("instructions" as const) : recipe.type,
              ...("verifiedAt" in recipe ? { verifiedAt: recipe.verifiedAt } : {}),
              ...(recipe.note ? { note: recipe.note, noteZh: recipe.noteZh } : {}),
            },
          }
        : {}),
    })
  }
  for (const section of mcp
    .split(/^## Examples\s*$/m)[1]
    ?.split(/^### /m)
    .slice(1) ?? []) {
    const name = section.split("\n")[0].trim()
    const intro = section.split("\n").find((line, index) => index > 0 && line.trim()) ?? ""
    const code = section.match(/```jsonc?[^\n]*\n([\s\S]*?)```/)
    if (!code) continue
    const errors: ParseError[] = []
    const config: unknown = parseJSONC(code[1], errors, { allowTrailingComma: true })
    if (
      errors.length ||
      !config ||
      typeof config !== "object" ||
      !("mcp" in config) ||
      !config.mcp ||
      typeof config.mcp !== "object"
    )
      continue
    const pair = Object.entries(config.mcp)[0]
    if (!pair || !/^[a-zA-Z0-9_-]{1,80}$/.test(pair[0])) continue
    const value = pair[1]
    if (
      !value ||
      typeof value !== "object" ||
      !("type" in value) ||
      value.type !== "remote" ||
      !("url" in value) ||
      typeof value.url !== "string"
    )
      continue
    const endpoint = webUrl(value.url)
    const id = `mcp:${pair[0]}`
    entries.set(id, {
      id,
      kind: "mcp",
      name,
      description: plain(intro),
      url: webUrl(intro.match(/\]\((https:\/\/[^)]+)\)/)?.[1] ?? endpoint),
      sourceUrl: `${docs}mcp-servers/#${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      // Only remote addresses are imported. Commands, environment variables and
      // credentials in documentation never become executable install recipes.
      mcp: { name: pair[0], url: endpoint, oauth: "oauth" in value && value.oauth !== false },
    })
  }
  const result = [...entries.values()]
  if (
    ["plugin", "project", "agent", "mcp"].some((kind) => !result.some((entry) => entry.kind === kind)) ||
    result.length > 500
  )
    throw new Error("Official directory format changed; keeping the previous directory")
  return result
}

async function download(url: string, fetcher: CatalogFetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: "error" })
  if (!response.ok) throw new Error(`Official directory returned HTTP ${response.status}`)
  if (!response.body) throw new Error("Official directory returned an empty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) throw new Error("Official directory is too large")
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export function createCatalogService(file: string, fetcher: CatalogFetch = fetch) {
  async function cached(): Promise<ExtensionCatalog> {
    try {
      const value = Schema.decodeUnknownSync(Snapshot)(JSON.parse(await fs.readFile(file, "utf8")))
      if (!Number.isFinite(Date.parse(value.fetchedAt))) throw new Error("Invalid cache timestamp")
      return { entries: parseCatalog(value.ecosystem, value.mcp), fetchedAt: value.fetchedAt, origin: "cache" }
    } catch {
      return {
        entries: parseCatalog(snapshot.ecosystem, snapshot.mcp),
        fetchedAt: snapshot.fetchedAt,
        origin: "bundled",
      }
    }
  }
  async function refresh(): Promise<ExtensionCatalog> {
    const previous = await cached()
    try {
      const [ecosystem, mcp] = await Promise.all([
        download(catalogSources.ecosystem, fetcher),
        download(catalogSources.mcp, fetcher),
      ])
      const entries = parseCatalog(ecosystem, mcp)
      const fetchedAt = new Date().toISOString()
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, ecosystem, mcp, fetchedAt }), { mode: 0o600 })
        await fs.rename(temporary, file)
      } finally {
        await fs.rm(temporary, { force: true })
      }
      return { entries, fetchedAt, origin: "remote" }
    } catch (error) {
      return { ...previous, warning: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    get: cached,
    refresh,
  }
}

export const catalog = createCatalogService(path.join(Global.Path.cache, "koma-extension-catalog.json"))
