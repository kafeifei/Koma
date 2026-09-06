import { expect, test } from "bun:test"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { isMessageStreaming, messageFieldAvailable, toolDisplayState } from "./message-availability"

const message: AssistantMessage = {
  id: "msg_native",
  sessionID: "ses_native",
  parentID: "msg_user",
  role: "assistant",
  time: { created: 0 },
  modelID: "unknown",
  providerID: "codex",
  mode: "codex",
  agent: "codex",
  path: { cwd: "", root: "" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

test("native compatibility placeholders are not display facts", () => {
  const native = {
    ...message,
    externalAvailability: { time: false, agent: false, model: false, cost: false, tokens: false },
  }
  expect(messageFieldAvailable(native, "time")).toBe(false)
  expect(messageFieldAvailable(native, "agent")).toBe(false)
  expect(messageFieldAvailable(native, "model")).toBe(false)
  expect(messageFieldAvailable(native, "cost")).toBe(false)
  expect(messageFieldAvailable(native, "tokens")).toBe(false)
})

test("native completed content does not stream when its timestamp is unavailable", () => {
  expect(isMessageStreaming({ ...message, externalStreaming: false })).toBe(false)
  expect(isMessageStreaming({ ...message, externalStreaming: true })).toBe(true)
})

test("OpenCode messages retain the existing timestamp behavior", () => {
  expect(messageFieldAvailable(message, "time")).toBe(true)
  expect(messageFieldAvailable(message, "tokens")).toBe(true)
  expect(isMessageStreaming(message)).toBe(true)
  expect(isMessageStreaming({ ...message, time: { created: 0, completed: 0 } })).toBe(false)
})

test("unrecognized native tool status keeps its output without claiming execution or success", () => {
  expect(
    toolDisplayState({
      id: "prt_unknown",
      sessionID: "ses_native",
      messageID: "msg_native",
      type: "tool",
      callID: "native-call",
      tool: "native-tool",
      state: { status: "pending", input: {}, raw: "{}" },
      externalStatus: "unknown",
      externalOutput: "native partial output",
    }),
  ).toEqual({ status: "unknown", output: "native partial output" })
})
