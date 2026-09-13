import { expect, test } from "bun:test"
import { mkdtemp, rm, lstat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { projectlessWorkspace } from "./koma-projectless"

test("workspace retries reuse one directory; separate tasks get separate directories", async () => {
  const state = await mkdtemp(join(tmpdir(), "koma-projectless-test-"))
  try {
    const root = await projectlessWorkspace(state)
    const key = randomUUID()
    const [first, retry] = await Promise.all([projectlessWorkspace(state, key), projectlessWorkspace(state, key)])
    const second = await projectlessWorkspace(state, randomUUID())
    expect(first).toEqual(retry)
    expect(first.directory).not.toBe(root.directory)
    expect(first.directory).not.toBe(second.directory)
    expect((await lstat(first.directory)).isDirectory()).toBe(true)
    await expect(projectlessWorkspace(state, "../../outside")).rejects.toThrow("Invalid workspace key")
    const symlinkKey = randomUUID()
    await symlink(second.directory, join(root.directory, symlinkKey))
    await expect(projectlessWorkspace(state, symlinkKey)).rejects.toThrow("real directory")
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})
