import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { catalog } from "./catalog"
import { recipes, type FileRecipe } from "./recipes"
import { installPlugin } from "./plugins"

type ResourceFetch = (url: string, options: RequestInit) => Promise<Response>

function relative(file: string) {
  if (
    !file ||
    file.includes("\\") ||
    file.includes("\0") ||
    path.posix.isAbsolute(file) ||
    file.split("/").some((p) => p === ".." || p === ".")
  ) {
    throw new Error("Invalid resource file path")
  }
  return file
}

async function download(url: string, fetcher: ResourceFetch) {
  const parsed = new URL(url)
  if (parsed.origin !== "https://raw.githubusercontent.com" || parsed.username || parsed.password) {
    throw new Error("Invalid resource source")
  }
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body) throw new Error(`Resource download failed (${response.status})`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 4 * 1024 * 1024) throw new Error("Resource file is too large")
      chunks.push(item.value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks)
}

// Downloads and dependency resolution never import plugin code. An isolated
// directory also keeps failed installs and uninstall from touching user files.
export async function prepareFiles(
  recipe: FileRecipe,
  root = path.join(Global.Path.cache, "koma-resources"),
  fetcher: ResourceFetch = fetch,
  dependencies: typeof Npm.install = Npm.install,
) {
  if (!recipe.files.length || recipe.files.length > 100) throw new Error("Invalid resource file count")
  const names = new Set(recipe.files.map((file) => relative(file.path)))
  if (names.size !== recipe.files.length || names.has("koma-entry.mjs") || names.has("package.json")) {
    throw new Error("Conflicting resource files")
  }
  for (const file of [recipe.entry, ...(recipe.instructions ?? [])]) {
    if (file && !names.has(relative(file))) throw new Error("Resource entry is missing")
  }
  await fs.mkdir(root, { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, "resource-"))
  try {
    // Bounded batches avoid a large bundle flooding the network.
    for (let offset = 0; offset < recipe.files.length; offset += 6) {
      const batch = await Promise.allSettled(
        recipe.files.slice(offset, offset + 6).map(async (file) => {
          const data = await download(file.url, fetcher)
          if (createHash("sha256").update(data).digest("hex") !== file.sha256) {
            throw new Error(`Resource integrity check failed: ${file.path}`)
          }
          const target = path.join(directory, file.path)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, data, { mode: 0o600 })
        }),
      )
      const failed = batch.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    }
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: recipe.dependencies,
      }),
      { mode: 0o600 },
    )
    if (Object.keys(recipe.dependencies).length) await dependencies(directory)
    const instructions = (recipe.instructions ?? []).map((file) => path.join(directory, file))
    const entry = path.join(directory, "koma-entry.mjs")
    await fs.writeFile(
      entry,
      [
        ...(recipe.entry
          ? [
              `export * from ${JSON.stringify("./" + recipe.entry)}`,
              ...(recipe.defaultExport ? [`export { default } from ${JSON.stringify("./" + recipe.entry)}`] : []),
            ]
          : []),
        `export const KomaResourceConfiguration = async () => ({ config: async (config) => {`,
        `const instructions = ${JSON.stringify(instructions)};`,
        `if (instructions.length) config.instructions = [...new Set([...(config.instructions ?? []), ...instructions])];`,
        `const permissions = ${JSON.stringify(recipe.config?.permission ?? {})};`,
        `if (Object.keys(permissions).length) config.permission = { ...permissions, ...config.permission };`,
        `} });`,
      ].join("\n"),
      { mode: 0o600 },
    )
    return { directory, entry }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function installCatalogEntry(id: string) {
  const entry = (await catalog.get()).entries.find((entry) => entry.id === id)
  const recipe = entry && recipes[entry.url]
  if (!entry || !recipe) throw new Error("Resource installation method is not available. Refresh the directory.")
  if (recipe.type === "builtin" || recipe.type === "external") throw new Error(recipe.note)
  const resource = {
    catalogID: entry.id,
    name: entry.name,
    resourceKind: recipe.type === "files" && !recipe.entry ? ("instructions" as const) : ("plugin" as const),
  }
  if (recipe.type === "npm") return installPlugin({ spec: recipe.spec, options: {} }, resource)
  if (recipe.type !== "files") throw new Error("Resource installation method is not supported")
  const prepared = await prepareFiles(recipe)
  try {
    await installPlugin({ spec: prepared.entry, options: {} }, resource)
  } catch (error) {
    await fs.rm(prepared.directory, { recursive: true, force: true })
    throw error
  }
}
