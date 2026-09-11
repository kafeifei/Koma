import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { Flock } from "./util/flock"
import { StoragePaths } from "./storage-paths"

// This is a Lab process contract, not a Session execution coordinator.
export const protocol = 1
const claims = new Map<string, string>()

export type Connection = {
  pid: number
  protocol: 1
  url: string
  username: "opencode"
  password: string
  version?: string
}

type Owner = Omit<Connection, "url"> & { token: string; url?: string }

export async function discover(root: string): Promise<Connection | undefined> {
  const owner = await read(root)
  if (!owner || !alive(owner.pid)) return
  if (!owner.url) return
  const response = await fetch(new URL("/global/health", owner.url), {
    headers: headers(owner),
    signal: AbortSignal.timeout(1500),
  }).catch(() => undefined)
  if (!response?.ok) return
  const body: unknown = await response.json().catch(() => undefined)
  if (!body || typeof body !== "object" || !("healthy" in body) || body.healthy !== true) return
  return {
    pid: owner.pid,
    protocol,
    url: owner.url,
    username: owner.username,
    password: owner.password,
    ...("version" in body && typeof body.version === "string" ? { version: body.version } : {}),
  }
}

export async function ensure(root: string, start: () => Promise<void | number>): Promise<Connection> {
  return Flock.withLock(
    "lab-backend-start",
    async () => {
      const existing = await discover(root)
      if (existing) return existing
      const owner = await read(root)
      // A slow or suspended owner must never be replaced just because health timed out.
      const started = !owner || !alive(owner.pid) ? await start() : undefined
      const deadline = Date.now() + 45_000
      while (Date.now() < deadline) {
        const connection = await discover(root)
        if (connection) return connection
        if (started && !alive(started))
          throw new Error(
            `OpenCode Lab backend exited before becoming ready; see ${StoragePaths.resolve(root).root}/bin/.lab-backend/service.log`,
          )
        const current = await read(root)
        if (current && current.token !== owner?.token && !alive(current.pid))
          throw new Error("OpenCode Lab backend exited before becoming ready")
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error("OpenCode Lab backend is not responding; its ownership was preserved")
    },
    { dir: join(StoragePaths.resolve(root).root, "bin", ".lab-backend", "locks"), timeoutMs: 50_000 },
  )
}

// Claim before importing Global, opening SQLite, migrating data, or running a tool.
export async function claim(root: string) {
  const paths = StoragePaths.resolve(root)
  return Flock.withLock(
    "lab-backend-owner",
    async () => {
      const previous = await read(root)
      if (previous && alive(previous.pid))
        throw new Error(`OpenCode Lab backend already owns this profile (PID ${previous.pid})`)
      await assertNoLegacyOwners(root)
      const owner: Owner = {
        pid: process.pid,
        protocol,
        token: randomUUID(),
        username: "opencode",
        password: randomUUID(),
      }
      await save(root, owner)
      claims.set(paths.root, owner.token)
      return {
        username: owner.username,
        password: owner.password,
        async ready(url: string) {
          requireLoopback(url)
          await assertOwner(root, owner.token)
          await save(root, { ...owner, url })
        },
        async release() {
          await Flock.withLock(
            "lab-backend-owner",
            async () => {
              await assertOwner(root, owner.token)
              await rm(join(paths.root, "bin", ".lab-backend", "backend.json"))
              claims.delete(paths.root)
            },
            { dir: join(paths.root, "bin", ".lab-backend", "locks") },
          )
        },
      }
    },
    { dir: join(paths.root, "bin", ".lab-backend", "locks"), timeoutMs: 10_000 },
  )
}

// v2 retains all paths and data. Its required backend protocol makes older Lab
// entrypoints refuse the profile, instead of silently resuming independent writes.
export async function activate(root: string) {
  const metadata = StoragePaths.metadata(root)
  if (!metadata || metadata.status !== "complete")
    throw new Error("Lab storage migration must finish before activation")
  const current = await read(root)
  if (!current || current.pid !== process.pid || claims.get(StoragePaths.resolve(root).root) !== current.token) {
    throw new Error("Only the Lab backend owner can activate this profile")
  }
  const file = StoragePaths.resolve(root).metadata
  const original = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
  await atomic(file, { ...original, version: 2, backendProtocol: protocol })
}

export function headers(connection: Pick<Connection, "username" | "password">) {
  return { Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` }
}

// The one core hook needed to prevent another entrypoint from bypassing Lab's
// client adapter. It does nothing for upstream or unactivated v1 profiles.
export function assertWriter(root: string) {
  if (StoragePaths.metadata(root)?.version !== 2) return
  const owner: unknown = JSON.parse(readFileSync(join(root, "bin", ".lab-backend", "backend.json"), "utf8"))
  if (
    !owner ||
    typeof owner !== "object" ||
    !("pid" in owner) ||
    owner.pid !== process.pid ||
    !("protocol" in owner) ||
    owner.protocol !== protocol ||
    !("token" in owner) ||
    claims.get(StoragePaths.resolve(root).root) !== owner.token
  ) {
    throw new Error("This Lab profile is owned by the shared backend; connect using opencode-lab")
  }
}

export async function stop(root: string, expected?: Pick<Connection, "pid" | "password">) {
  const connection = await discover(root)
  if (!connection) {
    const owner = await read(root)
    if (expected && (!owner || !alive(owner.pid))) return
    throw new Error("No healthy OpenCode Lab backend is running")
  }
  if (expected && (connection.pid !== expected.pid || connection.password !== expected.password))
    throw new Error("OpenCode Lab backend ownership changed; refusing to stop another backend")
  // Stop only the authenticated backend, and wait for it to release the profile before relaunch.
  process.kill(connection.pid, "SIGTERM")
  const deadline = Date.now() + 5_000
  while (alive(connection.pid)) {
    const owner = await read(root)
    if (!owner || owner.pid !== connection.pid || owner.password !== connection.password) return
    if (Date.now() >= deadline) throw new Error("OpenCode Lab backend did not stop in time")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function read(root: string): Promise<Owner | undefined> {
  const raw = await readFile(
    join(StoragePaths.resolve(root).root, "bin", ".lab-backend", "backend.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (raw === undefined) return
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object" || !("protocol" in value) || value.protocol !== protocol) {
    throw new Error("Incompatible OpenCode Lab backend protocol; use a compatible Lab build")
  }
  if (
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !value.token ||
    !("password" in value) ||
    typeof value.password !== "string" ||
    !value.password ||
    !("username" in value) ||
    value.username !== "opencode" ||
    ("url" in value && typeof value.url !== "string")
  )
    throw new Error("Invalid OpenCode Lab backend ownership record")
  if ("url" in value) requireLoopback(String(value.url))
  return value as Owner
}

function requireLoopback(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Lab backend must use an authenticated loopback endpoint")
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    return true
  }
}

async function assertOwner(root: string, token: string) {
  if ((await read(root))?.token !== token) throw new Error("OpenCode Lab backend ownership changed")
}

async function save(root: string, owner: Owner) {
  const state = join(StoragePaths.resolve(root).root, "bin", ".lab-backend")
  await mkdir(state, { recursive: true, mode: 0o700 })
  await atomic(join(state, "backend.json"), owner)
}

async function atomic(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function assertNoLegacyOwners(root: string) {
  if (StoragePaths.metadata(root)?.version === 2) return
  // A valid staged identity update is reconciled by the owner after this check.
  // Reading its database path must not reject that recoverable .tmp beforehand.
  const database = join(StoragePaths.resolve(root).data, StoragePaths.metadata(root)?.database ?? "opencode.db")
  const exists = await stat(database).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
  if (!exists) return
  // Older binaries do not participate in the ownership contract. Detect them
  // before raising the storage format barrier; never stop another user's process.
  const result = await promisify(execFile)("lsof", ["-t", "--", database, `${database}-wal`, `${database}-shm`], {
    encoding: "utf8",
  }).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      typeof error.stdout === "string"
    )
      return { stdout: error.stdout }
    throw new Error("Cannot verify legacy Lab database owners; close older Lab clients and ensure lsof is available", {
      cause: error,
    })
  })
  const owners = result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => pid !== process.pid)
  if (owners.length)
    throw new Error(
      `An older process still has the Lab database open (PID ${[...new Set(owners)].join(", ")}). Close it before starting the shared backend.`,
    )
}

export * as LabBackend from "./lab-backend"
