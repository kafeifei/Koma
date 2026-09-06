import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { projectItem, projectNotification, projectThread } from "../src/projection.js"
import type { Thread } from "../src/protocol/generated/v2/Thread.js"

const thread = {
  id: "thread-1",
  extra: null,
  sessionId: "session-tree-1",
  forkedFromId: null,
  parentThreadId: null,
  preview: "hello",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "default",
  modelProvider: "openai",
  model: "gpt-test",
  reasoningEffort: "high",
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 2,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace",
  cliVersion: "0.153.4",
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [
    {
      id: "turn-1",
      items: [
        {
          type: "userMessage",
          id: "item-user",
          clientId: "client-1",
          content: [{ type: "text", text: "hello", text_elements: [] }],
        },
        {
          type: "agentMessage",
          id: "item-agent",
          text: "world",
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
        {
          type: "contextCompaction",
          id: "item-compact",
        },
      ],
      itemsView: { type: "full" },
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
    },
  ],
} as unknown as Thread

describe("Codex projection", () => {
  test("keeps IDs, refs, and explicit native order stable", () => {
    const first = projectThread(thread, { runtimeScope: "scope-1", revision: 1 })
    const second = projectThread(thread, { runtimeScope: "scope-1", revision: 2 })
    expect(first.turnOrder).toEqual(second.turnOrder)
    expect(first.turns[0]?.itemOrder).toEqual(second.turns[0]?.itemOrder)
    expect(first.turns[0]?.items[0]?.ref).toEqual({
      runtimeScope: "scope-1",
      threadID: "thread-1",
      turnID: "turn-1",
      itemID: "item-user",
    })
    expect(first.turns[0]?.items.map((item) => item.content.type)).toEqual(["message", "message", "compaction"])
  })

  test("preserves unknown items as browser-safe data", () => {
    const item = projectItem(
      { type: "futureThing", id: "future-1", nested: { value: 1 }, omitted: undefined },
      { runtimeScope: "scope-1", threadID: "thread-1", turnID: "turn-1" },
    )
    expect(item.content).toEqual({
      type: "unknown",
      nativeType: "futureThing",
      value: { type: "futureThing", id: "future-1", nested: { value: 1 } },
    })
  })

  test("maps full items, deltas, usage, and diffs without conflating them", () => {
    expect(
      projectNotification(
        {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-agent", delta: "!" },
        },
        "scope-1",
      ),
    ).toEqual({
      type: "itemAppend",
      threadID: "thread-1",
      turnID: "turn-1",
      itemID: "item-agent",
      field: "message",
      text: "!",
    })
    expect(
      projectNotification(
        { method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "diff" } },
        "scope-1",
      ).type,
    ).toBe("turnDiffReplace")
    expect(
      projectNotification(
        {
          method: "thread/tokenUsage/updated",
          params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { totalTokens: 9 } } },
        },
        "scope-1",
      ).type,
    ).toBe("usageReplace")
  })
  test("native wait and child activity omit absent fields from JSON tool inputs", () => {
    const ref = { runtimeScope: "scope-1", threadID: "thread-1", turnID: "turn-1" }
    const wait = projectItem(
      {
        type: "collabAgentToolCall",
        id: "wait-1",
        tool: "wait",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: ["child-1"],
        prompt: null,
      },
      ref,
    )
    expect(Schema.is(Schema.Json)(wait.content)).toBe(true)
    expect(wait.content).not.toHaveProperty("prompt")
    const activity = projectItem({ type: "subAgentActivity", id: "activity-1", kind: "wait" }, ref)
    expect(Schema.is(Schema.Json)(activity.content)).toBe(true)
    expect(activity.content).not.toHaveProperty("agentPath")
  })
})
