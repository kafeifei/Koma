import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KomaBackend } from "@opencode-ai/core/koma-backend"
import { StorageMigration } from "@opencode-ai/core/storage-migration"

const cwd = join(import.meta.dir, "../..")

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "opencode-lab-home-")))
  const root = join(base, "profile")
  const legacyRoot = `${root}.legacy`
  const processes: Bun.Subprocess<"ignore", "pipe", "pipe">[] = []
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("OPENCODE_") &&
        !key.startsWith("XDG_") &&
        !key.startsWith("CODEX_") &&
        !["HOME", "TMPDIR", "NODE_OPTIONS", "BUN_OPTIONS"].includes(key),
    ),
  )
  for (const [key, name] of Object.entries({
    HOME: "home",
    XDG_DATA_HOME: "xdg-data",
    XDG_CONFIG_HOME: "xdg-config",
    XDG_CACHE_HOME: "xdg-cache",
    XDG_STATE_HOME: "xdg-state",
    TMPDIR: "tmp",
  })) {
    env[key] = join(base, name)
    await mkdir(env[key]!, { recursive: true })
  }
  Object.assign(env, {
    OPENCODE_HOME: root,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  })

  const start = (args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "src/koma.ts", ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    processes.push(child)
    return child
  }
  const run = async (args: string[]) => {
    const child = start(args)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  }
  return {
    base,
    root,
    legacyRoot,
    start,
    run,
    async ready() {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const connection = await KomaBackend.discover(root).catch(() => undefined)
        if (connection) {
          // owner.ready is immediately followed by signal handler registration.
          await Bun.sleep(50)
          return connection
        }
        const exited = processes.at(-1)?.exitCode
        if (exited !== null)
          throw new Error(
            `Koma backend exited before readiness with code ${exited}: ${await new Response(processes.at(-1)!.stderr).text()}`,
          )
        await Bun.sleep(20)
      }
      throw new Error("Lab backend did not become ready")
    },
    async stop(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
      child.kill("SIGTERM")
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    },
    async [Symbol.asyncDispose]() {
      for (const child of processes) if (child.exitCode === null) child.kill("SIGTERM")
      await Promise.all(processes.map((child) => child.exited))
      await rm(base, { recursive: true, force: true })
    },
  }
}

test("read-only Lab commands do not initialize a profile", async () => {
  await using input = await fixture()
  const paths = await input.run(["debug", "paths"])
  expect(paths.code, paths.stderr).toBe(0)
  expect(paths.stdout).toContain(join(input.root, "worktrees"))
  expect(await stat(input.root).catch(() => undefined)).toBeUndefined()

  const help = await input.run(["--help"])
  expect(help.code, help.stderr).toBe(0)
  expect(help.stdout).toContain("koma")
  expect(await stat(input.root).catch(() => undefined)).toBeUndefined()

  const version = await input.run(["--version"])
  expect(version.code, version.stderr).toBe(0)
  expect(version.stdout.trim()).not.toBe("")
  expect(await stat(input.root).catch(() => undefined)).toBeUndefined()
})

test("backend serve alone initializes and activates a fresh profile", async () => {
  await using input = await fixture()
  const child = input.start(["backend", "serve"])
  const connection = await input.ready()
  expect(connection.pid).toBe(child.pid)
  expect(await Bun.file(join(input.root, "storage.json")).json()).toMatchObject({
    version: 2,
    backendProtocol: 1,
    source: null,
    status: "complete",
    database: "opencode.db",
  })
  const result = await input.stop(child)
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain("Koma backend listening")
  expect(await Bun.file(join(input.root, "bin/.lab-backend/backend.json")).exists()).toBe(false)
})

test("backend serve refuses legacy migration and preserves it for Desktop", async () => {
  await using input = await fixture()
  await mkdir(input.legacyRoot)
  await writeFile(join(input.legacyRoot, "user-data"), "preserved")
  const result = await input.run(["backend", "serve"])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("start the updated Koma desktop first")
  expect(await readFile(join(input.legacyRoot, "user-data"), "utf8")).toBe("preserved")
  expect(await Bun.file(join(input.root, "storage.json")).exists()).toBe(false)
  expect(await Bun.file(join(input.root, "bin/.lab-backend/backend.json")).exists()).toBe(false)
})

test("backend serve recovers matching identity staging and rejects a version mismatch", async () => {
  await using input = await fixture()
  await mkdir(input.legacyRoot)
  StorageMigration.prepareUnifiedHome({ root: input.root, legacyRoot: input.legacyRoot, acquireLock: () => true })
  const file = join(input.root, "storage.json")
  const current = await Bun.file(file).json()
  const directory = join(input.legacyRoot, "backend/data/opencode/worktree/project/archived")
  const mapping = { directory, path: join(input.root, "worktrees/project/archived") }
  await mkdir(join(input.root, "data/storage/worktree_lifecycle"), { recursive: true })
  await writeFile(
    join(input.root, "data/storage/worktree_lifecycle", `${createHash("sha256").update(directory).digest("hex")}.json`),
    JSON.stringify({ version: 1, directory, phase: "removed", intent: "archive" }),
  )
  const pending = { ...current, worktrees: [...current.worktrees, mapping] }
  const mismatched = { ...pending, version: 2, backendProtocol: 1 }
  await writeFile(`${file}.tmp`, JSON.stringify(mismatched))
  const rejected = await input.run(["backend", "serve"])
  expect(rejected.code).not.toBe(0)
  expect(rejected.stderr).toContain("not a completed worktree identity update")
  expect(await Bun.file(file).json()).toEqual(current)
  expect(await Bun.file(`${file}.tmp`).json()).toEqual(mismatched)

  await writeFile(`${file}.tmp`, JSON.stringify(pending))
  const child = input.start(["backend", "serve"])
  await input.ready()
  expect(await Bun.file(file).json()).toEqual({ ...pending, version: 2, backendProtocol: 1 })
  expect(await Bun.file(`${file}.tmp`).exists()).toBe(false)
  expect(await stat(directory).catch(() => undefined)).toBeUndefined()
  const result = await input.stop(child)
  expect(result.code, result.stderr).toBe(0)
})
