import { describe, expect, test } from "bun:test"
import type { LabSnapshotOutput } from "@opencode-ai/lab-client"
import { compareMessages } from "./session-message"
import { compareExternalVersion, projectExternalMessages } from "./session-external"

const messages = [
  {
    id: "msg_assistant",
    type: "assistant",
    streaming: false,
    orderKey: "turn/02",
    time: {},
    content: [
      {
        type: "tool",
        id: "tool_2",
        name: "codex.fileChange",
        time: { created: 12 },
        state: {
          status: "completed",
          input: { path: "src/a.ts" },
          structured: { files: [{ file: "src/a.ts" }] },
          content: [{ type: "file", uri: "file:///tmp/a.ts", mime: "text/plain", name: "a.ts" }],
        },
      },
      { type: "text", id: "text_1", text: "done" },
    ],
  },
  {
    id: "msg_user",
    type: "user",
    text: "edit it",
    files: [
      {
        uri: "file:///tmp/input.ts",
        mime: "text/plain",
        name: "input.ts",
        source: { text: "@input.ts", start: 0, end: 9 },
      },
    ],
    orderKey: "turn/01",
    time: { created: 10 },
  },
] as unknown as LabSnapshotOutput["messages"]

describe("external session projection", () => {
  test("preserves native order and converts files and structured tool state", () => {
    const result = projectExternalMessages({
      sessionID: "ses_external",
      messages,
      messageOrder: ["msg_user", "msg_assistant"],
      partOrder: { msg_assistant: ["text_1", "tool_2"] },
    })

    expect(result.messages.map((message) => message.id)).toEqual(["msg_user", "msg_assistant"])
    expect(result.messages[1]).toMatchObject({
      parentID: "msg_user",
      orderKey: "0000000000000001",
      externalStreaming: false,
      agent: "codex",
      modelID: "unknown",
      externalAvailability: { time: false, agent: false, model: false },
    })
    expect(result.parts.get("msg_user")?.[1]).toMatchObject({
      type: "file",
      url: "file:///tmp/input.ts",
      source: { path: "input.ts", text: { value: "@input.ts" } },
    })
    expect(result.parts.get("msg_assistant")?.map((part) => part.id)).toEqual(["text_1", "tool_2"])
    expect(result.parts.get("msg_assistant")?.[1]).toMatchObject({
      type: "tool",
      state: {
        status: "completed",
        metadata: { files: [{ file: "src/a.ts" }] },
        attachments: [{ url: "file:///tmp/a.ts" }],
      },
    })
    expect(result.timeline.map((message) => [message.id, message.type])).toEqual([
      ["msg_user", "user"],
      ["msg_assistant", "assistant"],
    ])
  })

  test("uses explicit message order rather than native identity keys for shared ordering", () => {
    const unordered = messages.map((message, index) => ({
      ...message,
      orderKey: index === 0 ? "native-a" : "native-z",
    }))
    const result = projectExternalMessages({
      sessionID: "ses_external",
      messages: unordered as LabSnapshotOutput["messages"],
      messageOrder: ["msg_user", "msg_assistant"],
    })
    expect(
      result.messages
        .slice()
        .sort(compareMessages)
        .map((message) => message.id),
    ).toEqual(["msg_user", "msg_assistant"])
    expect(result.messages.map((message) => message.orderKey)).toEqual(["0000000000000000", "0000000000000001"])
  })

  test("keeps a compatibility parent ahead of an assistant-only native item", () => {
    const result = projectExternalMessages({ sessionID: "ses_external", messages: [messages[0]!] })
    expect(
      result.messages
        .slice()
        .sort(compareMessages)
        .map((message) => message.id),
    ).toEqual(["msg_assistant:parent", "msg_assistant"])
  })

  test("preserves unknown native tool status and output without reporting completion", () => {
    const result = projectExternalMessages({
      sessionID: "ses_external",
      messages: [
        {
          id: "msg_unknown_tool",
          type: "assistant",
          orderKey: "native-tool",
          time: {},
          content: [
            {
              id: "tool_unknown",
              type: "tool",
              name: "codex.futureTool",
              time: {},
              state: {
                status: "unknown",
                input: '{"path":"src/new.ts"}',
                output: "native output",
                nativeStatus: "paused-by-runtime",
              },
            },
          ],
        },
      ],
    })

    expect(result.parts.get("msg_unknown_tool")?.[0]).toMatchObject({
      type: "tool",
      state: { status: "pending", input: { path: "src/new.ts" } },
      externalStatus: "unknown",
      externalOutput: "native output",
      metadata: { externalProvider: undefined },
    })
  })

  test("classifies revisions and connection epochs", () => {
    expect(compareExternalVersion(undefined, { epoch: "a", revision: 1 })).toBe("initial")
    expect(compareExternalVersion({ epoch: "a", revision: 1 }, { epoch: "a", revision: 1 })).toBe("duplicate")
    expect(compareExternalVersion({ epoch: "a", revision: 1 }, { epoch: "a", revision: 2 })).toBe("next")
    expect(compareExternalVersion({ epoch: "a", revision: 1 }, { epoch: "a", revision: 4 })).toBe("gap")
    expect(compareExternalVersion({ epoch: "a", revision: 4 }, { epoch: "b", revision: 1 })).toBe("epoch")
  })
})
