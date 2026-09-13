import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { komaBuildInputs } from "./koma-build-inputs"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "koma-build-inputs-"))
  roots.push(root)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "test")
  const write = async (file: string, value: string) => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), value)
  }
  await write(
    "packages/opencode/package.json",
    JSON.stringify({ name: "opencode", dependencies: { "@test/core": "workspace:*" } }),
  )
  await write("packages/core/package.json", JSON.stringify({ name: "@test/core" }))
  await write("packages/core/src/backend.ts", "original")
  await write("packages/app/package.json", JSON.stringify({ name: "@test/app" }))
  await write("packages/app/src/settings.tsx", "original")
  await write("bun.lock", "original")
  git("add", ".")
  git("commit", "-m", "initial")
  return { root, write, git, identity: (options = { bun: "1.3.14", release: false }) => komaBuildInputs(root, options) }
}

test("UI edits, unrelated untracked files and a new commit preserve the backend cache", async () => {
  const f = await fixture()
  const before = await f.identity()
  await f.write("packages/app/src/settings.tsx", "changed")
  await f.write("docs/new.md", "docs")
  expect(await f.identity()).toBe(before)
  f.git("add", ".")
  f.git("commit", "-m", "UI only")
  expect(await f.identity()).toBe(before)
})

test("dependency edits, untracked backend files, deletions and lockfile changes invalidate", async () => {
  const f = await fixture()
  const before = await f.identity()
  await f.write("packages/core/src/backend.ts", "changed")
  expect(await f.identity()).not.toBe(before)
  await f.write("packages/core/src/backend.ts", "original")
  await f.write("packages/core/src/added.ts", "new")
  expect(await f.identity()).not.toBe(before)
  await rm(join(f.root, "packages/core/src/added.ts"))
  await rm(join(f.root, "packages/core/src/backend.ts"))
  expect(await f.identity()).not.toBe(before)
  await f.write("packages/core/src/backend.ts", "original")
  expect(await f.identity()).toBe(before)
  await f.write("bun.lock", "updated")
  expect(await f.identity()).not.toBe(before)
})

test("workspace dependency graph changes and build options invalidate", async () => {
  const f = await fixture()
  const before = await f.identity()
  expect(await f.identity({ bun: "1.4.0", release: false })).not.toBe(before)
  expect(await f.identity({ bun: "1.3.14", release: true })).not.toBe(before)
  await f.write(
    "packages/core/package.json",
    JSON.stringify({ name: "@test/core", dependencies: { "@test/app": "workspace:*" } }),
  )
  const withApp = await f.identity()
  await f.write("packages/app/src/settings.tsx", "changed")
  expect(await f.identity()).not.toBe(withApp)
})
