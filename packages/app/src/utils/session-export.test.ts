import type { LabSnapshotOutput } from "@opencode-ai/lab-client"
import { describe, expect, test } from "bun:test"
import { fetchSessionExport, sessionExportFilename } from "./session-export"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

describe("sessionExportFilename", () => {
  test("generates filename from title", () => {
    expect(sessionExportFilename({ id: "ses_123", title: "Clone PR in worktree from fork" })).toBe(
      "clone-pr-in-worktree-from-fork.json",
    )
  })

  test("generates filename from slug when title missing", () => {
    expect(sessionExportFilename({ id: "ses_123", slug: "my-session-slug" })).toBe("my-session-slug.json")
  })

  test("falls back to id when title and slug are empty", () => {
    expect(sessionExportFilename({ id: "ses_123" })).toBe("ses_123.json")
  })
})

describe("fetchSessionExport", () => {
  test("fetches full transcript from client", async () => {
    const session = { id: "ses_1", title: "Test Session" } as Session
    const msg = { id: "msg_1", role: "user" } as Message
    const part = { id: "prt_1", type: "text", text: "hello" } as Part
    const messages = [{ info: msg, parts: [part] }]

    const client = {
      session: {
        get: async () => ({ data: session }),
        messages: async () => ({ data: messages }),
      },
    }

    const result = await fetchSessionExport({
      sessionID: "ses_1",
      client,
    })

    expect(result).toEqual({
      info: session,
      messages,
    })
  })

  test("throws when session not found", async () => {
    const client = {
      session: {
        get: async () => ({ data: null }),
        messages: async () => ({ data: [] }),
      },
    }

    expect(
      fetchSessionExport({
        sessionID: "ses_missing",
        client,
      }),
    ).rejects.toThrow("Session not found: ses_missing")
  })
})

test("exports the native snapshot without reading or fabricating an OpenCode transcript", async () => {
  const info = { id: "ses_native", title: "Native" } as Session
  const snapshot: LabSnapshotOutput = {
    descriptor: {
      sessionID: info.id,
      engine: "codex",
      epoch: "fixture",
      revision: 1,
      runtimeStatus: "idle",
      queuePaused: true,
      settings: {},
      capabilities: { prompt: true, steer: true, queue: "host", compact: false, images: true, permissions: true },
    },
    messages: [{ id: "msg_native", type: "assistant", time: {}, orderKey: "0", content: [] }],
    messageOrder: ["msg_native"],
    partOrder: {},
    interactions: [],
    deliveries: [],
    children: [],
    turnDiffs: {},
    usage: { status: "unavailable" },
    contextWindow: { status: "unavailable" },
    cost: { status: "unavailable" },
    sessionDiff: { status: "unavailable" },
  }
  let loaded = false
  const result = await fetchSessionExport({
    sessionID: info.id,
    external: {
      isExternal: () => true,
      load: async () => {
        loaded = true
        return true
      },
      data: { snapshots: { [info.id]: snapshot } },
    },
    client: {
      session: {
        get: async () => ({ data: info }),
        messages: async () => {
          throw new Error("OpenCode history must not be queried")
        },
      },
    },
  })
  expect(loaded).toBe(true)
  expect(result).toEqual({ format: "opencode-lab-native-v1", engine: "codex", info, snapshot })
})
