import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KomaBackend } from "../src/koma-backend"
import { StorageMigration } from "../src/storage-migration"

type Result = { ok: boolean; error?: string; pid: number; url: string; username: "opencode"; password: string }

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "opencode-backend-contract-")))
  const root = join(base, "storage")
  const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = []
  await Promise.all(["home", "tmp", "data", "config", "cache", "state"].map((name) => mkdir(join(base, name))))
  const env = {
    PATH: process.env.PATH,
    HOME: join(base, "home"),
    TMPDIR: join(base, "tmp"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_CACHE_HOME: join(base, "cache"),
    XDG_STATE_HOME: join(base, "state"),
    OPENCODE_HOME: root,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  }
  function start(mode: string, instance = "electron") {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixture/lab-backend-worker.ts"), mode, root], {
      cwd: base,
      env: { ...env, KOMA_BACKEND_INSTANCE: instance },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    children.push(child)
    return child
  }
  async function run(mode: string, instance = "electron"): Promise<Result> {
    const child = start(mode, instance)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    return JSON.parse(stdout)
  }
  const spawned = async (): Promise<{ pid: number }[]> => {
    const text = await readFile(join(base, "spawned.jsonl"), "utf8").catch(() => "")
    return text.trim()
      ? text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : []
  }
  return {
    base,
    root,
    start,
    run,
    spawned,
    async [Symbol.asyncDispose]() {
      // Only terminate children created by this fixture; never infer cleanup targets from an owner record.
      for (const child of children) if (child.exitCode === null) child.kill("SIGTERM")
      await Promise.all(children.map((child) => child.exited))
      for (const child of await spawned()) {
        try {
          process.kill(child.pid, "SIGTERM")
          const deadline = Date.now() + 10_000
          while (!(await Bun.file(join(base, `${child.pid}.stopped`)).exists())) {
            process.kill(child.pid, 0)
            if (Date.now() >= deadline) {
              process.kill(child.pid, "SIGKILL")
              throw new Error(`Fixture backend did not stop: ${child.pid}`)
            }
            await Bun.sleep(10)
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
        }
      }
      await rm(base, { recursive: true, force: true })
    },
  }
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 10_000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= deadline) throw new Error(`Fixture did not publish readiness: ${file}`)
    await Bun.sleep(10)
  }
}

test("concurrent independent ensure callers share one backend process", async () => {
  await using input = await fixture()
  const [first, second] = await Promise.all([input.run("ensure"), input.run("ensure")])
  expect(first.ok).toBe(true)
  expect(second).toEqual(first)
  expect(await input.spawned()).toEqual([{ pid: first.pid }])
  expect((await fetch(new URL("/global/health", first.url))).status).toBe(401)
  expect((await fetch(new URL("/global/health", first.url), { headers: KomaBackend.headers(first) })).status).toBe(200)
}, 20_000)

test("a second process cannot claim an owned instance", async () => {
  await using input = await fixture()
  const first = await input.run("ensure")
  const file = join(input.root, "bin/.koma-backend/backend.json")
  const before = await readFile(file, "utf8")
  const second = await input.run("claim")
  expect(second.ok).toBe(false)
  expect(second.error).toContain(`already owns this instance (PID ${first.pid})`)
  expect(await readFile(file, "utf8")).toBe(before)
  expect(() => process.kill(first.pid, 0)).not.toThrow()
}, 20_000)

test("a stale owner PID can be replaced by a healthy backend", async () => {
  await using input = await fixture()
  const exited = await input.run("claim")
  expect(exited.ok).toBe(true)
  expect(() => process.kill(exited.pid, 0)).toThrow()
  await writeFile(
    join(input.root, "bin/.koma-backend/backend.json"),
    JSON.stringify({
      pid: exited.pid,
      protocol: 1,
      token: randomUUID(),
      username: "opencode",
      password: randomUUID(),
    }),
  )
  const replacement = await input.run("ensure")
  expect(replacement.ok).toBe(true)
  expect(replacement.pid).not.toBe(exited.pid)
  expect(await input.spawned()).toEqual([{ pid: replacement.pid }])
}, 20_000)

test("stop rejects a different owner and preserves the running backend", async () => {
  await using input = await fixture()
  const connection = await input.run("ensure")
  expect(connection.ok).toBe(true)
  await expect(KomaBackend.stop(input.root, { pid: connection.pid, password: "another-owner" })).rejects.toThrow(
    "ownership changed",
  )
  expect((await KomaBackend.discover(input.root))?.pid).toBe(connection.pid)
})

test("failed health never replaces a live owner and reconnects when it recovers", async () => {
  await using input = await fixture()
  const first = await input.run("ensure")
  expect(first.ok).toBe(true)
  const headers = KomaBackend.headers(first)
  await fetch(new URL("/test/unhealthy", first.url), { headers })
  const connecting = input.run("ensure")
  await waitForFile(join(input.base, "health-rejected"))
  expect(await input.spawned()).toEqual([{ pid: first.pid }])
  expect((await Bun.file(join(input.root, "bin/.koma-backend/backend.json")).json()).pid).toBe(first.pid)
  await fetch(new URL("/test/healthy", first.url), { headers })
  expect(await connecting).toEqual(first)
  expect(await input.spawned()).toEqual([{ pid: first.pid }])
}, 20_000)

test("incompatible backend protocol fails before starting another process", async () => {
  await using input = await fixture()
  await mkdir(join(input.root, "bin/.koma-backend"), { recursive: true })
  const record = JSON.stringify({ protocol: 99, pid: process.pid })
  await writeFile(join(input.root, "bin/.koma-backend/backend.json"), record)
  const result = await input.run("ensure")
  expect(result.ok).toBe(false)
  expect(result.error).toContain("Incompatible Koma backend protocol")
  expect(await input.spawned()).toEqual([])
  expect(await readFile(join(input.root, "bin/.koma-backend/backend.json"), "utf8")).toBe(record)
}, 20_000)

test("independent processes resolve the same database without a host ownership gate", async () => {
  await using input = await fixture()
  const owner = await input.run("ensure")
  expect(owner.ok).toBe(true)
  const first = await input.run("database-path")
  const second = await input.run("database-path")
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
  expect(first.pid).not.toBe(second.pid)
  expect((first as Result & { path: string }).path).toBe(join(input.root, "data/opencode.db"))
  expect((second as Result & { path: string }).path).toBe((first as Result & { path: string }).path)
}, 20_000)

test.skipIf(!Bun.which("lsof"))(
  "an independent legacy database handle blocks claim without stopping its process",
  async () => {
    await using input = await fixture()
    await mkdir(join(input.root, "data"), { recursive: true })
    const file = join(input.root, "data/opencode.db")
    const db = new Database(file)
    db.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('unchanged')")
    db.close()
    const before = await readFile(file)
    const legacy = input.start("hold-database")
    await waitForFile(join(input.base, "database-held"))
    const result = await input.run("claim")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("database open")
    expect(result.error).toContain(String(legacy.pid))
    expect(() => process.kill(legacy.pid, 0)).not.toThrow()
    expect(await readFile(file)).toEqual(before)
    expect(await Bun.file(join(input.root, "bin/.koma-backend/backend.json")).exists()).toBe(false)
  },
  20_000,
)

test.skipIf(!Bun.which("lsof"))(
  "activation preserves migrated metadata and database contents and inode",
  async () => {
    await using input = await fixture()
    const legacyRoot = join(input.base, "legacy")
    await mkdir(join(legacyRoot, "backend/data/opencode"), { recursive: true })
    const db = new Database(join(legacyRoot, "backend/data/opencode/opencode-lab.db"))
    db.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('before activation')")
    db.close()
    await using lease = await StorageMigration.lock(input.root)
    StorageMigration.prepareUnifiedHome({ root: input.root, legacyRoot, acquireLock: () => true })
    const file = join(input.root, "storage.json")
    const metadata = { ...(await Bun.file(file).json()), retainedExtension: { value: "keep" } }
    expect(metadata.version).toBe(1)
    expect(metadata.operations.length).toBeGreaterThan(0)
    await writeFile(file, JSON.stringify(metadata))
    const database = join(input.root, "data/opencode-lab.db")
    const before = await readFile(database)
    const inode = await stat(database)
    const result = await input.run("activate")
    expect(result.ok).toBe(true)
    expect(await Bun.file(file).json()).toEqual({ ...metadata, version: 2, backendProtocol: 1 })
    expect(await readFile(database)).toEqual(before)
    expect((await stat(database)).ino).toBe(inode.ino)
    expect(await realpath(join(legacyRoot, "backend/data/opencode/opencode-lab.db"))).toBe(database)
  },
  20_000,
)

test("Electron and Tauri instances have independent ports and shutdown with one data path", async () => {
  await using input = await fixture()
  const electron = await input.run("ensure", "electron")
  const tauri = await input.run("ensure", "tauri")
  expect(electron.ok).toBe(true)
  expect(tauri.ok).toBe(true)
  expect(tauri.pid).not.toBe(electron.pid)
  expect(tauri.url).not.toBe(electron.url)
  expect(tauri.password).not.toBe(electron.password)
  const [left, right] = await Promise.all([input.run("database-path", "electron"), input.run("database-path", "tauri")])
  expect(left.ok && right.ok).toBe(true)
  expect((left as Result & { path: string }).path).toBe((right as Result & { path: string }).path)
  expect((await input.run("stop", "tauri")).ok).toBe(true)
  expect(
    (await fetch(new URL("/global/health", electron.url), { headers: KomaBackend.headers(electron) })).status,
  ).toBe(200)
  expect(await Bun.file(join(input.root, "bin/.koma-instances/tauri/backend.json")).exists()).toBe(false)
  expect((await input.run("ensure", "electron")).pid).toBe(electron.pid)
}, 20_000)
