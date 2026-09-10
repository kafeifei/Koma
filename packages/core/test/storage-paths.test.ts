import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-storage-paths-"))
  roots.push(value)
  return value
}

async function databasePath(env: Record<string, string | undefined>) {
  const childEnv = { ...process.env, ...env }
  Object.entries(childEnv).forEach(([key, value]) => {
    if (value === undefined) delete childEnv[key]
  })
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const { Database } = await import("./src/database/database.ts"); console.log(Database.path())',
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: childEnv as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  return stdout.trim()
}

describe("storage paths", () => {
  test("resolves every shared directory from one absolute root", async () => {
    const dir = await root()

    expect(StoragePaths.resolve(dir)).toEqual({
      root: dir,
      desktop: path.join(dir, "desktop"),
      data: path.join(dir, "data"),
      config: path.join(dir, "config"),
      cache: path.join(dir, "cache"),
      state: path.join(dir, "state"),
      log: path.join(dir, "logs", "backend"),
      worktree: path.join(dir, "worktrees"),
      repos: path.join(dir, "repos"),
      bin: path.join(dir, "cache", "bin"),
      tmp: path.join(os.tmpdir(), "opencode"),
      snapshot: path.join(dir, "data", "snapshots"),
      codex: path.join(dir, "engines", "codex"),
      metadata: path.join(dir, "storage.json"),
    })
  })

  test("constructs a complete profile without reading migration metadata", async () => {
    const dir = await root()
    await Bun.write(path.join(dir, "storage.json"), "invalid metadata")

    const profile = StoragePaths.profile(dir)
    expect(profile.root).toBe(dir)
    expect(profile.snapshot).toBe(path.join(dir, "data", "snapshots"))
    expect(profile.worktree).toBe(path.join(dir, "worktrees"))
    expect(profile.codex).toBe(path.join(dir, "engines", "codex"))
    expect(profile).not.toHaveProperty("metadata")
    expect((await fs.readdir(dir)).sort()).toEqual(["storage.json"])
    expect(() => StoragePaths.profile("relative/profile")).toThrow("must be absolute")
  })

  test("uses the fresh database when metadata is absent", async () => {
    const dir = await root()
    expect(StoragePaths.metadata(dir)).toBeUndefined()
    expect(StoragePaths.database(dir)).toBe(path.join(dir, "data", "opencode.db"))
  })

  test("keeps the migrated database basename", async () => {
    const dir = await root()
    await Bun.write(
      path.join(dir, "storage.json"),
      JSON.stringify({
        version: 1,
        source: "/old/lab/backend",
        status: "complete",
        database: "opencode-lab.db",
        codexScope: `codex:${"a".repeat(64)}`,
        worktrees: [{ directory: "/old/worktree", path: path.join(dir, "worktrees", "project", "task") }],
      }),
    )

    expect(StoragePaths.metadata(dir)).toEqual({
      version: 1,
      source: "/old/lab/backend",
      status: "complete",
      database: "opencode-lab.db",
      codexScope: `codex:${"a".repeat(64)}`,
      worktrees: [{ directory: "/old/worktree", path: path.join(dir, "worktrees", "project", "task") }],
    })
    expect(StoragePaths.database(dir)).toBe(path.join(dir, "data", "opencode-lab.db"))
    expect(
      await databasePath({
        OPENCODE_DB: undefined,
        OPENCODE_HOME: dir,
        XDG_DATA_HOME: path.join(dir, "xdg-data"),
        XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
        XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
        XDG_STATE_HOME: path.join(dir, "xdg-state"),
      }),
    ).toBe(path.join(dir, "data", "opencode-lab.db"))
  })

  test("rejects incomplete migration metadata", async () => {
    const dir = await root()
    await Bun.write(
      path.join(dir, "storage.json"),
      JSON.stringify({ version: 1, source: "/old/lab/backend", status: "migrating", database: "opencode-lab.db" }),
    )

    expect(() => StoragePaths.database(dir)).toThrow("migration is incomplete")
  })

  test("preserves the shared backend requirement in version 2 metadata", async () => {
    const dir = await root()
    const manifest = {
      version: 2,
      backendProtocol: 1,
      source: null,
      status: "complete",
      database: "opencode.db",
    } as const
    await Bun.write(path.join(dir, "storage.json"), JSON.stringify(manifest))

    expect(StoragePaths.metadata(dir)).toEqual(manifest)
    expect(StoragePaths.database(dir)).toBe(path.join(dir, "data", "opencode.db"))
  })

  test("rejects an absent or unsupported shared backend protocol", async () => {
    const dir = await root()
    for (const backendProtocol of [undefined, 0, 2, "1"]) {
      await Bun.write(
        path.join(dir, "storage.json"),
        JSON.stringify({ version: 2, backendProtocol, source: null, status: "complete", database: "opencode.db" }),
      )
      expect(() => StoragePaths.metadata(dir)).toThrow("Unsupported OpenCode storage backend protocol")
    }
  })

  test("rejects a pending atomic metadata write", async () => {
    const dir = await root()
    await Bun.write(path.join(dir, "storage.json.tmp"), "pending")

    expect(() => StoragePaths.database(dir)).toThrow("migration is incomplete")
  })

  test("rejects database paths outside the data directory", async () => {
    const dir = await root()
    await Bun.write(
      path.join(dir, "storage.json"),
      JSON.stringify({ version: 1, source: "/old/lab/backend", status: "complete", database: "../outside.db" }),
    )

    expect(() => StoragePaths.metadata(dir)).toThrow("Invalid OpenCode storage database name")
  })

  test("rejects non-absolute worktree mappings", async () => {
    const dir = await root()
    await Bun.write(
      path.join(dir, "storage.json"),
      JSON.stringify({
        version: 1,
        source: null,
        status: "complete",
        database: "opencode.db",
        worktrees: [{ directory: "relative", path: path.join(dir, "worktrees", "task") }],
      }),
    )

    expect(() => StoragePaths.metadata(dir)).toThrow("Invalid OpenCode storage worktree mapping")
  })

  test("Global uses shared paths only for an absolute OPENCODE_HOME", async () => {
    const dir = await root()
    const home = path.join(dir, "home")
    const shared = path.join(dir, "shared")
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        'const { Global } = await import("./src/global.ts"); console.log(JSON.stringify(Global.Path))',
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: {
          ...process.env,
          HOME: home,
          OPENCODE_TEST_HOME: home,
          OPENCODE_HOME: shared,
          XDG_DATA_HOME: path.join(dir, "xdg-data"),
          XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
          XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
          XDG_STATE_HOME: path.join(dir, "xdg-state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      root: shared,
      desktop: path.join(shared, "desktop"),
      data: path.join(shared, "data"),
      config: path.join(shared, "config"),
      cache: path.join(shared, "cache"),
      state: path.join(shared, "state"),
      log: path.join(shared, "logs", "backend"),
      worktree: path.join(shared, "worktrees"),
      repos: path.join(shared, "repos"),
      snapshot: path.join(shared, "data", "snapshots"),
      codex: path.join(shared, "engines", "codex"),
    })
  })

  test("Global rejects a relative OPENCODE_HOME before creating storage directories", async () => {
    const dir = await root()
    const proc = Bun.spawn([process.execPath, "-e", 'await import("./src/global.ts")'], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: path.join(dir, "home"),
        OPENCODE_TEST_HOME: path.join(dir, "home"),
        OPENCODE_HOME: "relative/storage",
        XDG_DATA_HOME: path.join(dir, "xdg-data"),
        XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
        XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
        XDG_STATE_HOME: path.join(dir, "xdg-state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain("OPENCODE_HOME must be an absolute path")
    expect(await Bun.file(path.join(dir, "xdg-data")).exists()).toBe(false)
  })

  test("Global rejects incomplete migration metadata before creating data directories", async () => {
    const dir = await root()
    await Bun.write(
      path.join(dir, "storage.json"),
      JSON.stringify({ version: 1, source: null, status: "migrating", database: "opencode.db", worktrees: [] }),
    )
    const proc = Bun.spawn([process.execPath, "-e", 'await import("./src/global.ts")'], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: path.join(dir, "home"),
        OPENCODE_TEST_HOME: path.join(dir, "home"),
        OPENCODE_HOME: dir,
        XDG_DATA_HOME: path.join(dir, "xdg-data"),
        XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
        XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
        XDG_STATE_HOME: path.join(dir, "xdg-state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain("migration is incomplete")
    expect(await Bun.file(path.join(dir, "data")).exists()).toBe(false)
  })

  test("keeps the channel database behavior when shared storage is disabled", async () => {
    const dir = await root()
    expect(
      await databasePath({
        OPENCODE_DB: undefined,
        OPENCODE_HOME: undefined,
        OPENCODE_DISABLE_CHANNEL_DB: "1",
        HOME: path.join(dir, "home"),
        OPENCODE_TEST_HOME: path.join(dir, "home"),
        XDG_DATA_HOME: path.join(dir, "xdg-data"),
        XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
        XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
        XDG_STATE_HOME: path.join(dir, "xdg-state"),
      }),
    ).toBe(path.join(dir, "xdg-data", "opencode", "opencode.db"))
  })
})
