import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-lab-cli-"))
  roots.push(root)
  return path.join(root, "home")
}

async function launch(root: string) {
  const env = { ...process.env }
  for (const key of ["OPENCODE_DB", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_AUTH_CONTENT"])
    delete env[key]
  const proc = Bun.spawn([process.execPath, "run", "src/lab.ts", "debug", "paths"], {
    cwd: path.join(import.meta.dir, "../.."),
    env: { ...env, OPENCODE_HOME: root, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("Lab CLI creates one shared home and reuses its completed manifest", async () => {
  const root = await fixture()
  const first = await launch(root)
  expect(first.code, first.stderr).toBe(0)
  expect(first.stdout).toContain(path.join(root, "worktrees"))
  expect(first.stdout).toContain(path.join(root, "config"))
  const manifest = await Bun.file(path.join(root, "storage.json")).text()
  expect(JSON.parse(manifest)).toMatchObject({ status: "complete", source: null, database: "opencode.db" })
  const second = await launch(root)
  expect(second.code, second.stderr).toBe(0)
  expect(await Bun.file(path.join(root, "storage.json")).text()).toBe(manifest)
})

test("Lab CLI never moves an existing desktop profile", async () => {
  const root = await fixture()
  await fs.mkdir(`${root}.legacy`)
  await Bun.write(path.join(`${root}.legacy`, "user-data"), "preserved")
  const result = await launch(root)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("start the updated OpenCode Lab first")
  expect(await Bun.file(path.join(`${root}.legacy`, "user-data")).text()).toBe("preserved")
  expect(await Bun.file(path.join(root, "storage.json")).exists()).toBe(false)
})

test("Lab CLI rejects an interrupted migration before backend startup", async () => {
  const root = await fixture()
  await fs.mkdir(root)
  await Bun.write(path.join(root, "storage.json.tmp"), "interrupted")
  const result = await launch(root)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("migration is incomplete")
  expect(await fs.readdir(root)).toEqual(["storage.json.tmp"])
})
