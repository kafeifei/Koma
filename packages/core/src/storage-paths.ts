import fs from "fs"
import os from "os"
import path from "path"

const databases = new Set(["opencode.db", "opencode-lab.db", "opencode-local.db"])

export interface Metadata {
  readonly version: 1 | 2
  readonly backendProtocol?: 1
  readonly source: string | null
  readonly status: "migrating" | "complete"
  readonly database: string
  readonly codexScope?: string
  readonly worktrees?: ReadonlyArray<WorktreeMapping>
}

export interface WorktreeMapping {
  readonly directory: string
  readonly path: string
}

export function resolve(root: string) {
  if (!path.isAbsolute(root)) throw new Error(`OpenCode storage root must be absolute: ${root}`)

  const normalized = path.normalize(root)
  return {
    root: normalized,
    desktop: path.join(normalized, "desktop"),
    data: path.join(normalized, "data"),
    config: path.join(normalized, "config"),
    cache: path.join(normalized, "cache"),
    state: path.join(normalized, "state"),
    log: path.join(normalized, "logs", "backend"),
    worktree: path.join(normalized, "worktrees"),
    repos: path.join(normalized, "repos"),
    bin: path.join(normalized, "cache", "bin"),
    tmp: path.join(os.tmpdir(), "opencode"),
    snapshot: path.join(normalized, "data", "snapshots"),
    codex: path.join(normalized, "engines", "codex"),
    metadata: path.join(normalized, "storage.json"),
  }
}

/** Pure path construction: this does not inspect a manifest or create a profile. */
export function profile(root: string) {
  const { metadata, ...paths } = resolve(root)
  return paths
}

type Profile = ReturnType<typeof profile>

/** Keep service overrides from retaining paths derived from another storage location. */
export function overrides(input: Partial<Profile>, current: Pick<Profile, "data" | "cache">): Partial<Profile> {
  if (input.root !== undefined) {
    const paths = profile(input.root)
    for (const key of Object.keys(paths) as (keyof Profile)[]) {
      if (key === "tmp" || !(key in input)) continue
      const value = input[key]
      if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== paths[key]) {
        throw new Error(`OpenCode storage ${key} must match the profile rooted at ${paths.root}`)
      }
    }
    return { ...paths, tmp: input.tmp ?? paths.tmp }
  }

  return {
    ...(input.data !== undefined && input.data !== current.data
      ? {
          root: undefined,
          desktop: undefined,
          codex: undefined,
          log: input.log ?? path.join(input.data, "log"),
          repos: input.repos ?? path.join(input.data, "repos"),
          worktree: input.worktree ?? path.join(input.data, "worktree"),
          snapshot: input.snapshot ?? path.join(input.data, "snapshot"),
        }
      : {}),
    ...(input.cache !== undefined && input.cache !== current.cache
      ? { bin: input.bin ?? path.join(input.cache, "bin") }
      : {}),
  }
}

export function metadata(root: string): Metadata | undefined {
  const file = resolve(root).metadata
  if (!fs.existsSync(file)) return

  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!isRecord(value)) throw new Error(`Invalid OpenCode storage metadata: ${file}`)
  if (value.version !== 1 && value.version !== 2) {
    throw new Error(`Unsupported OpenCode storage metadata version: ${String(value.version)}`)
  }
  if (value.version === 2 ? value.backendProtocol !== 1 : value.backendProtocol !== undefined) {
    throw new Error(`Unsupported OpenCode storage backend protocol: ${String(value.backendProtocol)}`)
  }
  if (value.source !== null && (typeof value.source !== "string" || !path.isAbsolute(value.source))) {
    throw new Error(`Invalid OpenCode storage metadata source: ${file}`)
  }
  if (value.status !== "migrating" && value.status !== "complete") {
    throw new Error(`Invalid OpenCode storage metadata status: ${file}`)
  }
  if (
    typeof value.database !== "string" ||
    !databases.has(value.database) ||
    path.basename(value.database) !== value.database
  ) {
    throw new Error(`Invalid OpenCode storage database name: ${file}`)
  }
  if (
    value.codexScope !== undefined &&
    (typeof value.codexScope !== "string" || !/^codex:[a-f0-9]{64}$/.test(value.codexScope))
  ) {
    throw new Error(`Invalid OpenCode storage Codex scope: ${file}`)
  }
  if (value.worktrees !== undefined && !isWorktrees(value.worktrees)) {
    throw new Error(`Invalid OpenCode storage worktree mapping: ${file}`)
  }
  return {
    version: value.version,
    ...(value.version === 2 ? { backendProtocol: 1 as const } : {}),
    source: value.source,
    status: value.status,
    database: value.database,
    ...(value.codexScope === undefined ? {} : { codexScope: value.codexScope }),
    ...(value.worktrees === undefined ? {} : { worktrees: value.worktrees }),
  }
}

export function database(root: string) {
  const paths = resolve(root)
  if (fs.existsSync(`${paths.metadata}.tmp`)) {
    throw new Error(`OpenCode storage migration is incomplete: ${paths.metadata}.tmp`)
  }
  const manifest = metadata(root)
  if (!manifest) return path.join(paths.data, "opencode.db")
  if (manifest.status !== "complete") throw new Error(`OpenCode storage migration is incomplete: ${paths.metadata}`)
  return path.join(paths.data, manifest.database)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isWorktrees(value: unknown): value is WorktreeMapping[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.directory === "string" &&
        path.isAbsolute(item.directory) &&
        typeof item.path === "string" &&
        path.isAbsolute(item.path),
    )
  )
}

export * as StoragePaths from "./storage-paths"
