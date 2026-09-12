import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionExternal } from "@opencode-ai/schema/session-external"
import { snapshotUpdate, toolOutputAppend } from "../src/snapshot-update"

const descriptor: SessionExternal.Descriptor = {
  sessionID: "ses_fixture" as SessionExternal.Descriptor["sessionID"],
  engine: "codex",
  epoch: "runtime",
  revision: 1,
  runtimeStatus: "active",
  queuePaused: false,
  settings: {},
  capabilities: { prompt: true, steer: true, queue: "host", compact: false, images: true, permissions: true },
}
const baseline = (): SessionExternal.Snapshot => ({
  descriptor,
  messages: [
    {
      id: "history" as SessionExternal.Message["id"],
      type: "user",
      text: "previous output ".repeat(30_000),
      orderKey: "1",
      time: {},
    },
  ],
  messageOrder: ["history"],
  partOrder: { history: ["history:text"] },
  interactions: [],
  deliveries: [],
  usage: { status: "unavailable" },
  contextWindow: { status: "unavailable" },
  cost: { status: "unavailable" },
  turnDiffs: {},
  sessionDiff: { status: "unavailable" },
  children: [],
})
const tool = (output: string): SessionExternal.Message => ({
  id: "message" as SessionExternal.Message["id"],
  type: "assistant",
  orderKey: "2",
  time: {},
  streaming: true,
  content: [
    {
      id: "part",
      type: "tool",
      name: "exec",
      time: {},
      state: {
        status: "running",
        input: { command: "build" },
        content: output ? [{ type: "text", text: output }] : [],
        structured: { output, nativeStatus: "inProgress" },
      },
    },
  ],
})

describe("Codex wire updates", () => {
  test("state-only changes omit a large unchanged history and round-trip through the event schema", () => {
    const before = baseline()
    const after = {
      ...before,
      descriptor: { ...descriptor, revision: 2 },
      usage: {
        status: "available" as const,
        value: { input: 5, output: 3, reasoning: 1, cache: { read: 0, write: 0 } },
      },
    }
    const patch = snapshotUpdate(before, after)
    const wire = {
      sessionID: descriptor.sessionID,
      epoch: descriptor.epoch,
      revision: 2,
      descriptor: after.descriptor,
      refresh: true,
      ...patch,
    }
    const encoded = Schema.encodeUnknownSync(SessionExternal.Changed.data)(wire)
    expect(Schema.decodeUnknownSync(SessionExternal.Changed.data)(encoded)).toEqual(wire)
    expect(patch.messages).toBeUndefined()
    expect(patch.update).toEqual({ baseRevision: 1, usage: after.usage })
    expect(JSON.stringify(wire).length).toBeLessThan(1_000)
    expect(JSON.stringify(before).length).toBeGreaterThan(400_000)
  })

  test("removed messages and unavailable optional metrics replace stale client state", () => {
    const before = { ...baseline(), contextTokens: { status: "available" as const, value: 123 } }
    const after = { ...baseline(), messages: [], messageOrder: [], partOrder: {} }
    const patch = snapshotUpdate(before, after)
    expect(patch.update).toMatchObject({ messageOrder: [], contextTokens: { status: "unavailable" } })
  })

  test("appending one message does not resend a long timeline index", () => {
    const before = baseline()
    const ids = Array.from({ length: 2_000 }, (_, index) => `message_${index}`)
    const large = { ...before, messageOrder: ids, partOrder: Object.fromEntries(ids.map((id) => [id, [`${id}:part`]])) }
    const message = { ...before.messages[0], id: "new" as SessionExternal.Message["id"], text: "new message" }
    const next = {
      ...large,
      messages: [...large.messages, message],
      messageOrder: [...ids, "new"],
      partOrder: { ...large.partOrder, new: ["new:part"] },
    }
    const patch = snapshotUpdate(large, next)
    expect(patch.update?.messageOrder).toBeUndefined()
    expect(patch.update?.partOrder).toEqual({ new: ["new:part"] })
    expect(patch.messages).toEqual([message])
    expect(JSON.stringify(patch).length).toBeLessThan(400)
  })

  test("tool output chunks stay bounded as accumulated output grows", () => {
    for (const size of [0, 100_000, 1_000_000]) {
      const output = "x".repeat(size)
      const patch = toolOutputAppend(tool(output), tool(output + "next line\n"))
      expect(patch).toEqual({ messageID: "message", partID: "part", offset: size, delta: "next line\n" })
      expect(JSON.stringify(patch).length).toBeLessThan(100)
    }
  })

  test("tool rewrites or status changes cannot masquerade as output appends", () => {
    expect(toolOutputAppend(tool("before"), tool("replacement"))).toBeUndefined()
    const next = tool("beforeafter")
    if (next.type !== "assistant" || next.content[0].type !== "tool" || next.content[0].state.status !== "running")
      throw new Error("fixture")
    const completed = {
      ...next,
      content: [{ ...next.content[0], state: { ...next.content[0].state, status: "completed" as const } }],
    }
    expect(toolOutputAppend(tool("before"), completed)).toBeUndefined()
  })
})
