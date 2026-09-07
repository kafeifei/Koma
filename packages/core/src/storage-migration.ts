export * as StorageMigration from "./storage-migration"

import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

const directories = ["desktop", "data", "config", "cache", "state", "logs", "worktrees", "repos", "engines/codex"]
const databases = ["opencode.db", "opencode-lab.db", "opencode-local.db"]

type Operation = { from: string; to: string; ino: number; dev: number }
export type HomeStorage = {
  version: 1
  source: string | null
  status: "migrating" | "complete"
  database: string
  codexScope: string
  worktrees: { directory: string; path: string }[]
  operations: Operation[]
}

type Options = { root: string; legacyRoot: string }
type Checkpoint = { stage: "manifest" | "renamed" | "linked" | "complete"; from?: string; to?: string }

/** Shared only for initialization; moving legacy data still requires the Electron singleton lock. */
export async function lock(root: string) {
  const { Flock } = await import("./util/flock")
  return Flock.acquire("storage-home", {
    dir: join(tmpdir(), `opencode-storage-${createHash("sha256").update(resolve(root)).digest("hex")}`),
    timeoutMs: 30_000,
  })
}

/** Read-only: an interrupted first rename may have moved Electron's singleton directory. */
export function unifiedHomeLockPath(options: Options) {
  const root = resolve(options.root)
  const legacyRoot = resolve(options.legacyRoot)
  const manifest = readManifest(root, legacyRoot)
  if (!manifest) return legacyRoot
  if (!manifest.source) return join(root, "desktop")
  const operation = manifest.operations[0]
  if (operation && !entry(legacyRoot) && matches(join(root, "desktop"), operation)) return join(root, "desktop")
  return legacyRoot
}

/** The caller must hold the returned singleton lock until its normal process shutdown. */
export function prepareUnifiedHome(
  options: Options & {
    acquireLock: () => boolean
    checkpoint?: (event: Checkpoint) => void
  },
) {
  if (!options.acquireLock()) return undefined
  const root = resolve(options.root)
  const legacyRoot = resolve(options.legacyRoot)
  if (root === legacyRoot || inside(root, legacyRoot) || inside(legacyRoot, root)) fail("overlapping roots", root)
  const previous = readManifest(root, legacyRoot)
  const manifest = previous ?? plan(root, legacyRoot)
  if (previous?.source === null && entry(legacyRoot)) fail("legacy data appeared after home initialization", legacyRoot)
  if (previous && !entry(join(root, "storage.json"))) {
    renameSync(join(root, "storage.json.tmp"), join(root, "storage.json"))
    syncDirectory(root)
  }
  if (!previous) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    syncDirectory(dirname(root))
    save(root, manifest)
    options.checkpoint?.({ stage: "manifest" })
  }
  // Even a completed migration is checked: never silently start against broken aliases or missing data.
  for (const operation of manifest.operations) {
    const source = entry(operation.from)
    const target = entry(operation.to)
    if (source?.isSymbolicLink() && resolve(dirname(operation.from), readlinkSync(operation.from)) === operation.to) {
      if (!matches(operation.to, operation)) fail("migration destination changed", operation.to)
      continue
    }
    if (source && target) fail("independent source and destination both exist", operation.from)
    if (source && !matches(operation.from, operation)) fail("migration source changed", operation.from)
    if (!source && !matches(operation.to, operation))
      fail("migration source and destination missing or changed", operation.from)
    requireParents(root, operation.to)
    if (source) {
      mkdirSync(dirname(operation.to), { recursive: true, mode: 0o700 })
      if (statSync(dirname(operation.to)).dev !== operation.dev)
        fail("cross-device migration is not supported", operation.to)
      renameSync(operation.from, operation.to)
      syncDirectory(dirname(operation.from))
      syncDirectory(dirname(operation.to))
      options.checkpoint?.({ stage: "renamed", from: operation.from, to: operation.to })
    }
    // If symlink creation fails, the durable intent and destination inode allow the next startup to resume.
    symlinkSync(operation.to, operation.from, "dir")
    syncDirectory(dirname(operation.from))
    options.checkpoint?.({ stage: "linked", from: operation.from, to: operation.to })
  }
  for (const directory of directories) {
    requireParents(root, join(root, directory, "placeholder"))
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 })
  }
  for (const alias of mappings(root, legacyRoot).slice(1)) {
    requireParents(root, join(alias.to, "placeholder"))
    mkdirSync(alias.to, { recursive: true, mode: 0o700 })
    const current = entry(alias.from)
    if (current?.isSymbolicLink() && resolve(dirname(alias.from), readlinkSync(alias.from)) === alias.to) continue
    if (current) fail("compatibility path contains independent data", alias.from)
    requireParents(root, alias.from)
    mkdirSync(dirname(alias.from), { recursive: true, mode: 0o700 })
    symlinkSync(alias.to, alias.from, "dir")
    syncDirectory(dirname(alias.from))
    options.checkpoint?.({ stage: "linked", from: alias.from, to: alias.to })
  }
  if (manifest.status !== "complete") {
    manifest.status = "complete"
    save(root, manifest)
    options.checkpoint?.({ stage: "complete" })
  }
  return {
    root,
    desktop: join(root, "desktop"),
    database: manifest.database,
    codexScope: manifest.codexScope,
    status: "complete" as const,
  }
}

function plan(root: string, legacyRoot: string): HomeStorage {
  if (entry(root)?.isSymbolicLink()) fail("unified home must not be a symlink", root)
  if (entry(root) && (!statSync(root).isDirectory() || readdirSync(root).some((name) => name !== "bin"))) {
    fail("unified home already contains independent data", root)
  }
  const source = entry(legacyRoot)
  if (source && (!source.isDirectory() || source.isSymbolicLink()))
    fail("legacy home is not an owned directory", legacyRoot)
  const databasePath = join(legacyRoot, "backend/data/opencode")
  const candidates = databases.filter((name) => entry(join(databasePath, name)))
  for (const name of databases) {
    if (
      !entry(join(databasePath, name)) &&
      ["-wal", "-shm"].some((suffix) => entry(join(databasePath, name + suffix)))
    ) {
      fail("database sidecars exist without their database", join(databasePath, name))
    }
  }
  if (!candidates.includes("opencode-lab.db") && candidates.length > 1) fail("ambiguous legacy database", databasePath)
  const operations = source
    ? mappings(root, legacyRoot).flatMap((mapping) => {
        requireParents(legacyRoot, mapping.original)
        const current = entry(mapping.original)
        if (!current) return []
        if (!current.isDirectory() || current.isSymbolicLink())
          fail("migration source is not an owned directory", mapping.original)
        // A sibling snapshots directory would be overwritten by the legacy snapshot rename.
        if (mapping.from === join(root, "data/snapshot") && entry(join(databasePath, "snapshots"))) {
          fail("both snapshot and snapshots exist", databasePath)
        }
        return [{ from: mapping.from, to: mapping.to, ino: current.ino, dev: current.dev }]
      })
    : []
  const nearest = existingParent(root)
  if (source && statSync(nearest).dev !== source.dev) fail("cross-device migration is not supported", root)
  return {
    version: 1,
    source: source ? legacyRoot : null,
    status: "migrating",
    database: candidates.includes("opencode-lab.db") ? "opencode-lab.db" : (candidates[0] ?? "opencode.db"),
    codexScope: `codex:${createHash("sha256")
      .update(source ? join(legacyRoot, "backend/state/opencode/codex") : join(root, "engines/codex"))
      .digest("hex")}`,
    worktrees: source ? legacyWorktrees(root, legacyRoot) : [],
    operations,
  }
}

function legacyWorktrees(root: string, legacyRoot: string) {
  const base = join(legacyRoot, "backend/data/opencode/worktree")
  if (!entry(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((project) => project.isDirectory())
    .flatMap((project) =>
      readdirSync(join(base, project.name), { withFileTypes: true })
        .filter((worktree) => worktree.isDirectory())
        .map((worktree) => ({
          directory: join(base, project.name, worktree.name),
          path: join(root, "worktrees", project.name, worktree.name),
        })),
    )
}

function mappings(root: string, legacyRoot: string) {
  return [
    { original: legacyRoot, from: legacyRoot, to: join(root, "desktop") },
    ...["data", "config", "cache", "state"].map((name) => ({
      original: join(legacyRoot, "backend", name, "opencode"),
      from: join(root, "desktop/backend", name, "opencode"),
      to: join(root, name),
    })),
    ...[
      ["worktree", "worktrees"],
      ["repos", "repos"],
      ["snapshot", "data/snapshots"],
      ["log", "logs/backend"],
    ].map(([from, to]) => ({
      original: join(legacyRoot, "backend/data/opencode", from!),
      from: join(root, "data", from!),
      to: join(root, to!),
    })),
    { original: join(legacyRoot, "logs"), from: join(root, "desktop/logs"), to: join(root, "logs/desktop") },
    {
      original: join(legacyRoot, "backend/state/opencode/codex"),
      from: join(root, "state/codex"),
      to: join(root, "engines/codex"),
    },
  ]
}

function readManifest(root: string, legacyRoot: string): HomeStorage | undefined {
  const file = entry(join(root, "storage.json")) ? join(root, "storage.json") : join(root, "storage.json.tmp")
  if (!entry(file)) return undefined
  if (entry(root)?.isSymbolicLink() || !entry(file)?.isFile()) fail("invalid storage manifest location", file)
  const value: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (!value || typeof value !== "object") fail("invalid storage manifest", file)
  const manifest = value as Partial<HomeStorage>
  if (
    manifest.version !== 1 ||
    !["migrating", "complete"].includes(manifest.status ?? "") ||
    (manifest.source !== null && manifest.source !== legacyRoot) ||
    !databases.includes(manifest.database ?? "") ||
    !/^codex:[a-f0-9]{64}$/.test(manifest.codexScope ?? "") ||
    !Array.isArray(manifest.operations) ||
    !Array.isArray(manifest.worktrees)
  )
    fail("invalid storage manifest", file)
  for (const worktree of manifest.worktrees) {
    if (!worktree || typeof worktree.directory !== "string" || typeof worktree.path !== "string")
      fail("invalid worktree mapping", file)
    const suffix = relative(join(legacyRoot, "backend/data/opencode/worktree"), worktree.directory)
    if (
      !inside(join(legacyRoot, "backend/data/opencode/worktree"), worktree.directory) ||
      suffix.split(/[\/\\]/).length !== 2 ||
      worktree.path !== join(root, "worktrees", suffix)
    )
      fail("invalid worktree mapping", file)
  }
  const allowed = mappings(root, legacyRoot)
  const indices = manifest.operations.map((operation) => {
    if (!operation || !Number.isSafeInteger(operation.ino) || !Number.isSafeInteger(operation.dev))
      fail("invalid migration identity", file)
    const index = allowed.findIndex((mapping) => mapping.from === operation.from && mapping.to === operation.to)
    if (index < 0) fail("invalid migration operation", file)
    return index
  })
  if (manifest.source === null && manifest.worktrees.length !== 0) fail("fresh home has legacy worktree mappings", file)
  if (
    indices.some((index, position) => position > 0 && index <= indices[position - 1]!) ||
    (manifest.source === null ? indices.length !== 0 : indices[0] !== 0)
  )
    fail("invalid migration order", file)
  return manifest as HomeStorage
}

function save(root: string, manifest: HomeStorage) {
  // A crash before rename can leave this private staging file; storage.json remains authoritative.
  const temporary = join(root, "storage.json.tmp")
  if (entry(temporary)) {
    if (!entry(temporary)?.isFile()) fail("invalid manifest staging file", temporary)
    unlinkSync(temporary)
  }
  const descriptor = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(descriptor, JSON.stringify(manifest, null, 2) + "\n")
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, join(root, "storage.json"))
  syncDirectory(root)
}

function syncDirectory(path: string) {
  const descriptor = openSync(path, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function requireParents(root: string, path: string) {
  const parts = relative(root, dirname(path))
    .split(/[\/\\]/)
    .filter(Boolean)
  if (parts.includes("..")) return
  parts.forEach((_, index) => {
    const parent = join(root, ...parts.slice(0, index + 1))
    const current = entry(parent)
    if (current && (!current.isDirectory() || current.isSymbolicLink()))
      fail("migration parent is not an owned directory", parent)
  })
}

function entry(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })
}

function matches(path: string, operation: Operation) {
  const current = entry(path)
  return !!current && current.isDirectory() && current.ino === operation.ino && current.dev === operation.dev
}

function inside(parent: string, child: string) {
  const path = relative(parent, child)
  return !!path && path !== ".." && !path.startsWith("../") && !isAbsolute(path)
}

function existingParent(path: string): string {
  return existsSync(path) ? path : existingParent(dirname(path))
}

function fail(reason: string, path: string): never {
  throw new Error(`Unified home migration stopped: ${reason}: ${path}`)
}
