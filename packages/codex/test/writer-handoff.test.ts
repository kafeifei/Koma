import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { writerHandoff } from "../src/writer-handoff"

test("handoff addresses the exact owner, authenticates, and preserves unrelated tasks", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "writer-handoff-"))
  const released: string[] = []
  const owner = await writerHandoff({
    home,
    owns: (id) => id === "task",
    release: async (id) => {
      released.push(id)
    },
  })
  const peer = await writerHandoff({
    home,
    owns: () => false,
    release: async () => {
      throw new Error("not owner")
    },
  })
  try {
    const directory = path.join(home, "koma-hosts")
    const files = await readdir(directory)
    const file = path.join(directory, files[0]!)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const record = JSON.parse(await readFile(file, "utf8"))
    expect((await fetch(`${record.url}/release?threadID=task`, { method: "POST" })).status).toBe(401)
    expect(await peer.release("unrelated")).toBe(false)
    expect(await peer.release("task")).toBe(true)
    expect(released).toEqual(["task"])
  } finally {
    await peer.close()
    await owner.close()
  }
  expect(await readdir(path.join(home, "koma-hosts"))).toEqual([])
  await rm(home, { recursive: true })
})

test("a live owner refusal is returned; stale peers do not authorize a release", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "writer-handoff-"))
  const owner = await writerHandoff({
    home,
    owns: () => true,
    release: async () => {
      throw new Error("tools still running")
    },
  })
  const peer = await writerHandoff({ home, owns: () => false, release: async () => {} })
  try {
    await writeFile(
      path.join(home, "koma-hosts", "a.json"),
      JSON.stringify({ url: "http://127.0.0.1:1", token: "stale" }),
    )
    await expect(peer.release("task")).rejects.toThrow("tools still running")
  } finally {
    await peer.close()
    await owner.close()
    await rm(home, { recursive: true })
  }
})
