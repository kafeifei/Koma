import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { hasWriterRecovery, unloadWriter } from "../src/writer-unload"
import type { CodexRuntime } from "../src/session"

test("interrupted native unload restores only the previously active family on retry", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "writer-unload-"))
  const archived = new Set(["already-archived-child"])
  let archives = 0,
    fail = true
  const runtime = {
    readThread: async (id: string) => ({
      thread: {
        id,
        path: `/${archived.has(id) ? "archived_sessions" : "sessions"}/${id}`,
        status: { type: "idle" },
        turns: [],
      },
    }),
    client: {
      request: async (method: string, params: { threadId?: string; archived?: boolean }) => {
        if (method === "thread/list") {
          expect(params.archived).toBe(false)
          return { data: [{ id: "child" }], nextCursor: null }
        }
        if (method === "thread/archive") {
          archives++
          archived.add("parent")
          archived.add("child")
          return {}
        }
        if (method === "thread/unarchive") {
          if (fail) {
            fail = false
            throw new Error("connection lost")
          }
          archived.delete(params.threadId!)
          return { thread: { id: params.threadId } }
        }
      },
    },
  } as unknown as CodexRuntime
  try {
    await expect(unloadWriter(runtime, home, "parent")).rejects.toThrow("connection lost")
    expect(await hasWriterRecovery(home, "parent")).toBe(true)
    expect(await unloadWriter(runtime, home, "parent", true)).toBe(true)
    expect(archives).toBe(1)
    expect([...archived]).toEqual(["already-archived-child"])
    expect(await hasWriterRecovery(home, "parent")).toBe(false)
    expect(await unloadWriter(runtime, home, "parent", true)).toBe(false)
  } finally {
    await rm(home, { recursive: true })
  }
})

test("a running descendant prevents native archival", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "writer-unload-"))
  const calls: string[] = []
  const runtime = {
    readThread: async () => ({ thread: { status: { type: "active" }, turns: [] } }),
    client: {
      request: async (method: string) => {
        calls.push(method)
        return { data: [{ id: "child" }], nextCursor: null }
      },
    },
  } as unknown as CodexRuntime
  try {
    await expect(unloadWriter(runtime, home, "parent")).rejects.toThrow("child task is still running")
    expect(calls).toEqual(["thread/list"])
    expect(await hasWriterRecovery(home, "parent")).toBe(false)
  } finally {
    await rm(home, { recursive: true })
  }
})
