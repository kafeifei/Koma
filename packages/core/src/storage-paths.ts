import fs from "fs"
import os from "os"
import path from "path"

const databases = new Set(["opencode.db", "opencode-lab.db", "opencode-local.db"])

export interface Metadata {
  readonly version: 1
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

export function metadata(root: string): Metadata | undefined {
  const file = resolve(root).metadata
  if (!fs.existsSync(file)) return

  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!isRecord(value)) throw new Error(`Invalid OpenCode storage metadata: ${file}`)
  if (value.version !== 1) throw new Error(`Unsupported OpenCode storage metadata version: ${String(value.version)}`)
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
