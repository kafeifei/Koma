import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StorageDirectory } from "../src/storage-directory"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

test("migrated worktree aliases preserve identity through every old path component", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-directory-")))
  roots.push(root)
  const legacy = path.join(root, "Application Support", "OpenCode Lab")
  const directory = path.join(legacy, "backend", "data", "opencode", "worktree", "project", "old")
  const physical = path.join(root, "worktrees", "project", "old")
  await fs.mkdir(path.join(physical, "src"), { recursive: true })
  await fs.mkdir(path.join(root, "desktop", "backend", "data"), { recursive: true })
  await fs.mkdir(path.dirname(legacy), { recursive: true })
  await fs.mkdir(path.join(root, "data"))
  await fs.symlink(path.join(root, "desktop"), legacy)
  await fs.symlink(path.join(root, "data"), path.join(root, "desktop", "backend", "data", "opencode"))
  await fs.symlink(path.join(root, "worktrees"), path.join(root, "data", "worktree"))
  await Bun.write(
    path.join(root, "storage.json"),
    JSON.stringify({
      version: 1,
      source: legacy,
      status: "complete",
      database: "opencode.db",
      worktrees: [{ directory, path: physical }],
    }),
  )

  expect(await fs.realpath(directory)).toBe(physical)
  expect(StorageDirectory.resolve(directory, root)).toBe(directory)
  expect(StorageDirectory.resolve(physical, root)).toBe(directory)
  expect(StorageDirectory.resolve(path.join(physical, "src"), root)).toBe(path.join(directory, "src"))
  expect(StorageDirectory.resolve(path.join(physical, "new-file"), root)).toBe(path.join(directory, "new-file"))

  const fresh = path.join(root, "worktrees", "project", "fresh")
  await fs.mkdir(fresh)
  expect(StorageDirectory.resolve(fresh, root)).toBe(fresh)
  expect(StorageDirectory.resolve(`${physical}-other`, root)).toBe(`${physical}-other`)
  await fs.symlink(fresh, path.join(physical, "outside"))
  expect(StorageDirectory.resolve(path.join(physical, "outside"), root)).toBe(path.join(physical, "outside"))
  expect(await fs.realpath(path.join(directory, "outside"))).toBe(fresh)
})

test("without migration metadata directory identity is unchanged", () => {
  expect(StorageDirectory.resolve("/some/alias", undefined)).toBe("/some/alias")
})
