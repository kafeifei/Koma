import { expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cwd = join(import.meta.dir, "../..")
const name = process.platform === "win32" ? "opencode-lab.exe" : "opencode-lab"

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "opencode-lab-maintenance-")))
  const root = join(base, "profile")
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("OPENCODE_") &&
        !key.startsWith("XDG_") &&
        !key.startsWith("CODEX_") &&
        !["HOME", "TMPDIR", "NODE_OPTIONS", "BUN_OPTIONS"].includes(key),
    ),
  )
  for (const [key, directory] of Object.entries({
    HOME: "home",
    XDG_DATA_HOME: "xdg-data",
    XDG_CONFIG_HOME: "xdg-config",
    XDG_CACHE_HOME: "xdg-cache",
    XDG_STATE_HOME: "xdg-state",
    TMPDIR: "tmp",
  })) {
    env[key] = join(base, directory)
    await mkdir(env[key]!, { recursive: true })
  }
  env.OPENCODE_HOME = root
  const run = async (args: string[], extra: Record<string, string> = {}, bunArgs: string[] = []) => {
    const child = Bun.spawn([process.execPath, ...bunArgs, "src/lab.ts", ...args], {
      cwd,
      env: { ...env, ...extra },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
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
    env,
    run,
    async [Symbol.asyncDispose]() {
      await rm(base, { recursive: true, force: true })
    },
  }
}

async function managed(input: Awaited<ReturnType<typeof fixture>>) {
  const hash = "a".repeat(64)
  const version = join(input.root, "bin/.opencode-lab", hash, name)
  const target = join(input.root, "bin", name)
  const shell = join(input.env.HOME!, ".local/bin", name)
  await mkdir(join(version, ".."), { recursive: true })
  await mkdir(join(shell, ".."), { recursive: true })
  await writeFile(version, "backend executable")
  await symlink(join(".opencode-lab", hash, name), target)
  await symlink(target, shell)
  await mkdir(join(input.root, "bin/.lab-backend"), { recursive: true })
  await writeFile(join(input.root, "bin/.lab-backend/service.log"), "running backend log")
  await mkdir(join(input.root, "data"), { recursive: true })
  await writeFile(join(input.root, "data/opencode.db"), "shared database")
  await mkdir(join(input.root, "config"), { recursive: true })
  await writeFile(join(input.root, "config/opencode.json"), "shared config")
  await writeFile(join(input.env.HOME!, ".local/bin/opencode"), "official opencode")
  return { version, target, shell }
}

test("Lab uninstall plans then removes only managed command entries", async () => {
  await using input = await fixture()
  const paths = await managed(input)
  const dryRun = await input.run(["uninstall", "--dry-run"])
  expect(dryRun.code, dryRun.stderr).toBe(0)
  expect(JSON.parse(dryRun.stdout)).toEqual({
    removed: [],
    planned: [paths.shell, paths.target],
    sharedDataPreserved: true,
  })
  expect((await lstat(paths.target)).isSymbolicLink()).toBe(true)
  expect((await lstat(paths.shell)).isSymbolicLink()).toBe(true)

  const confirmed = await input.run(["uninstall", "--yes"])
  expect(confirmed.code, confirmed.stderr).toBe(0)
  expect(JSON.parse(confirmed.stdout)).toEqual({
    removed: [paths.shell, paths.target],
    planned: [paths.shell, paths.target],
    sharedDataPreserved: true,
  })
  expect(await stat(paths.target).catch(() => undefined)).toBeUndefined()
  expect(await stat(paths.shell).catch(() => undefined)).toBeUndefined()
  expect(await readFile(paths.version, "utf8")).toBe("backend executable")
  expect(await readFile(join(input.root, "bin/.lab-backend/service.log"), "utf8")).toBe("running backend log")
  expect(await readFile(join(input.root, "data/opencode.db"), "utf8")).toBe("shared database")
  expect(await readFile(join(input.root, "config/opencode.json"), "utf8")).toBe("shared config")
  expect(await readFile(join(input.env.HOME!, ".local/bin/opencode"), "utf8")).toBe("official opencode")
})

test("Lab uninstall refuses independent files and unmanaged links", async () => {
  await using input = await fixture()
  const target = join(input.root, "bin", name)
  await mkdir(join(input.root, "bin"), { recursive: true })
  await writeFile(target, "independent command")
  const file = await input.run(["uninstall", "--yes"])
  expect(file.code).not.toBe(0)
  expect(file.stderr).toContain("Refusing to remove an independent executable")
  expect(await readFile(target, "utf8")).toBe("independent command")

  await unlink(target)
  await writeFile(join(input.root, "bin/custom"), "custom command")
  await symlink("custom", target)
  const link = await input.run(["uninstall", "--yes"])
  expect(link.code).not.toBe(0)
  expect(link.stderr).toContain("CLI entry is not managed by Lab")
  expect(await readFile(target, "utf8")).toBe("custom command")
})

test("Lab uninstall refuses an unrelated shell entry without changing the managed target", async () => {
  await using input = await fixture()
  const paths = await managed(input)
  await unlink(paths.shell)
  await writeFile(paths.shell, "user command")
  const result = await input.run(["uninstall", "--yes"])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("Refusing to remove an independent executable")
  expect(await readFile(paths.shell, "utf8")).toBe("user command")
  expect((await lstat(paths.target)).isSymbolicLink()).toBe(true)
  expect(await readFile(paths.version, "utf8")).toBe("backend executable")
})

test("Lab upgrade rejects before importing the upstream installer or initializing a profile", async () => {
  await using input = await fixture()
  const preload = join(input.base, "guard.ts")
  const loaded = join(input.base, "preload-loaded")
  const imported = join(input.base, "installer-imported")
  await writeFile(
    preload,
    `
      import { writeFileSync } from "node:fs"
      writeFileSync(process.env.LAB_PRELOAD_LOADED, "loaded")
      Bun.plugin({
        name: "reject-upstream-installer",
        setup(build) {
          build.onLoad({ filter: /packages[\\\\/]opencode[\\\\/]src[\\\\/]installation[\\\\/]index\\.ts$/ }, (args) => {
            writeFileSync(process.env.LAB_INSTALLER_IMPORTED, args.path)
            throw new Error("UPSTREAM_INSTALLER_IMPORTED")
          })
        },
      })
    `,
  )
  const result = await input.run(
    ["upgrade"],
    {
      LAB_PRELOAD_LOADED: loaded,
      LAB_INSTALLER_IMPORTED: imported,
    },
    [`--preload=${preload}`],
  )
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("verified Lab build")
  expect(result.stderr).not.toContain("UPSTREAM_INSTALLER_IMPORTED")
  expect(await readFile(loaded, "utf8")).toBe("loaded")
  expect(await stat(imported).catch(() => undefined)).toBeUndefined()
  expect(await stat(input.root).catch(() => undefined)).toBeUndefined()
})
