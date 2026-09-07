import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionExternal } from "@opencode-ai/schema/session-external"
import { SessionID } from "@opencode-ai/schema/session-id"
import type { CodexRolloutHistory } from "../src/history.js"
import { toBrowserValue, projectItem, type CodexThreadSnapshot } from "../src/projection.js"
import { codexViewIdentityKey, projectCodexRolloutView, projectCodexView, unifiedDiffs } from "../src/view.js"

import nativeTools from "./fixture/native-tools.json"

const sessionID = SessionID.descending("ses_codex-view")
const childSessionID = SessionID.descending("ses_child")
const snapshot: CodexThreadSnapshot = {
  runtimeScope: "scope_1",
  revision: 3,
  thread: {
    id: "thread-1",
    sessionID: "native-session",
    parentThreadID: null,
    forkedFromID: null,
    cwd: "/workspace",
    name: null,
    preview: "one",
    model: null,
    reasoningEffort: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
  },
  turnOrder: ["turn-projected"],
  turns: [
    {
      id: "turn-projected",
      orderKey: "turn-order",
      ref: { runtimeScope: "scope_1", threadID: "thread-1", turnID: "turn-1" },
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      itemOrder: ["first", "second", "third"],
      items: [
        {
          id: "first",
          orderKey: "001",
          ref: { runtimeScope: "scope_1", threadID: "thread-1", turnID: "turn-1", itemID: "live-user" },
          identity: "native",
          nativeType: "userMessage",
          content: { type: "message", role: "user", text: "first steer" },
        },
        {
          id: "second",
          orderKey: "002",
          ref: { runtimeScope: "scope_1", threadID: "thread-1", turnID: "turn-1", itemID: "second-user" },
          identity: "native",
          nativeType: "userMessage",
          content: { type: "message", role: "user", text: "second steer" },
        },
        {
          id: "third",
          orderKey: "003",
          ref: { runtimeScope: "scope_1", threadID: "thread-1", turnID: "turn-1", itemID: "subagent" },
          identity: "native",
          nativeType: "subAgentActivity",
          content: {
            type: "subagent",
            operation: "spawn",
            receiverThreadIDs: [],
            agentThreadID: "child-native",
          },
        },
      ],
      diff: {
        status: "available",
        value: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new\n",
      },
    },
  ],
  usage: {
    status: "available",
    value: {
      total: {
        totalTokens: 90,
        inputTokens: 5,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        outputTokens: 4,
        reasoningOutputTokens: 3,
      },
      last: {
        totalTokens: 9,
        inputTokens: 5,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        outputTokens: 4,
        reasoningOutputTokens: 3,
      },
      modelContextWindow: 100,
    },
  },
}

describe("Codex wire view", () => {
  test("presents recorded native command output and file patches without changing identities", () => {
    // Captured from native Codex 0.153.4 using the isolated local Responses fixture;
    // only its temporary workspace prefix has been normalized.
    const items = nativeTools.map((item) => projectItem(item, snapshot.turns[0]!.ref))
    const view = projectCodexView({ ...snapshot, turns: [{ ...snapshot.turns[0]!, items }] }, { sessionID })
    const commands = view.messages
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .filter((part) => part.type === "tool")
    expect(commands.map((part) => part.name)).toEqual([
      "codex.commandExecution",
      "codex.fileChange",
      "codex.commandExecution",
    ])
    expect("structured" in commands[0]!.state ? commands[0]!.state.structured : undefined).toMatchObject({
      output: "fixture-read-proof\nvalue=41\nsum=42\n",
      exitCode: 0,
    })
    expect("structured" in commands[1]!.state ? commands[1]!.state.structured : undefined).toMatchObject({
      files: [
        {
          filePath: "/workspace/sample.txt",
          type: "update",
          additions: 1,
          deletions: 1,
          diff: "@@ -1,2 +1,2 @@\n fixture-read-proof\n-value=41\n+value=42\n",
        },
      ],
    })
    expect("structured" in commands[2]!.state ? commands[2]!.state.structured : undefined).toMatchObject({
      commandActions: [{ type: "read" }],
      output: "fixture-read-proof\nvalue=42\n",
    })
    expect(items[2]!.raw).toEqual(toBrowserValue(nativeTools[2]))
  })

  test("gives native web search its query while retaining opaque results and unknown state", () => {
    const native = {
      type: "webSearch",
      id: "search-1",
      query: "Codex docs",
      action: { type: "search", query: "Codex docs" },
      results: [{ future: "opaque result" }],
    }
    const item = projectItem(native, snapshot.turns[0]!.ref)
    const view = projectCodexView({ ...snapshot, turns: [{ ...snapshot.turns[0]!, items: [item] }] }, { sessionID })
    const part = view.messages.flatMap((message) => (message.type === "assistant" ? message.content : []))[0]
    if (part?.type !== "tool" || part.state.status !== "unknown")
      throw new Error("Expected unknown native web search state")
    expect(part.name).toBe("codex.webSearch")
    expect(JSON.parse(part.state.input)).toEqual({ query: "Codex docs", value: native })
  })

  test("keeps streaming and failed command output available to the shell renderer", () => {
    for (const status of ["inProgress", "failed"]) {
      const item = projectItem({ ...nativeTools[0], status }, snapshot.turns[0]!.ref)
      const view = projectCodexView({ ...snapshot, turns: [{ ...snapshot.turns[0]!, items: [item] }] }, { sessionID })
      const part = view.messages.flatMap((message) => (message.type === "assistant" ? message.content : []))[0]
      expect(part?.type === "tool" && "structured" in part.state && part.state.structured).toMatchObject({
        output: nativeTools[0]!.aggregatedOutput,
      })
      expect(part?.type === "tool" && part.state.status).toBe(status === "failed" ? "error" : "running")
    }
  })

  test("uses only adopted child Session IDs in native task cards", () => {
    const child = snapshot.turns[0]!.items[2]!
    for (const adopted of [false, true]) {
      const view = projectCodexView(
        { ...snapshot, turns: [{ ...snapshot.turns[0]!, items: [child] }] },
        {
          sessionID,
          childSessions: adopted ? { "child-native": childSessionID } : {},
        },
      )
      const part = view.messages.flatMap((message) => (message.type === "assistant" ? message.content : []))[0]
      if (part?.type !== "tool" || part.state.status !== "unknown") throw new Error("Expected native unknown state")
      const input = JSON.parse(part.state.input)
      expect(input.nativeSubagent).toBe(true)
      expect(input.sessionId).toBe(adopted ? childSessionID : undefined)
    }
  })

  test("keeps native command exit code and duration in the inspectable tool result", () => {
    const view = projectCodexView(
      {
        ...snapshot,
        turns: [
          {
            ...snapshot.turns[0]!,
            items: [
              {
                ...snapshot.turns[0]!.items[0]!,
                nativeType: "commandExecution",
                content: {
                  type: "command",
                  command: "exit 3",
                  cwd: "/workspace",
                  status: "completed",
                  output: "native output",
                  exitCode: 3,
                  durationMs: 42,
                },
              },
            ],
          },
        ],
      },
      { sessionID },
    )
    const message = view.messages[0]!
    expect(message.type).toBe("assistant")
    if (message.type !== "assistant") throw new Error("Expected command message")
    const tool = message.content[0]!
    expect(tool.type).toBe("tool")
    if (tool.type !== "tool") throw new Error("Expected command tool")
    expect(tool.state.input).toEqual({ command: "exit 3", cwd: "/workspace" })
    if (tool.state.status !== "completed") throw new Error("Expected native completed status")
    expect(tool.state.structured).toEqual({
      nativeStatus: "completed",
      exitCode: 3,
      durationMs: 42,
      output: "native output",
    })
    expect(tool.state.content).toEqual([{ type: "text", text: "native output" }])
  })

  test("keeps native item order, optional facts, usage, diffs, and child refs", () => {
    const view = projectCodexView(snapshot, {
      sessionID,
      childSessions: { "child-native": childSessionID },
    })
    expect(view.messages.map((message) => message.type)).toEqual(["user", "user", "assistant"])
    expect(view.messages.map((message) => (message.type === "user" ? message.text : message.type))).toEqual([
      "first steer",
      "second steer",
      "assistant",
    ])
    expect(view.messageOrder).toEqual(view.messages.map((message) => message.id))
    expect(view.messages.every((message) => Schema.is(SessionExternal.Message)(message))).toBe(true)
    expect(view.usage).toEqual({
      status: "available",
      value: { total: 90, input: 5, output: 4, reasoning: 3, cache: { read: 2, write: 1 } },
    })
    expect(view.contextWindow).toEqual({ status: "available", value: 100 })
    expect(view.contextTokens).toEqual({ status: "available", value: 9 })
    expect(view.turnDiffs["turn-1"]).toEqual({
      status: "available",
      value: [
        {
          file: "a.ts",
          patch: snapshot.turns[0]?.diff.status === "available" ? snapshot.turns[0].diff.value : "",
          additions: 1,
          deletions: 1,
          status: "modified",
        },
      ],
    })
    expect(view.nativeChildren).toEqual([
      {
        sourceItemID: "subagent",
        nativeThreadID: "child-native",
        parentNativeThreadID: "thread-1",
        sessionID: childSessionID,
      },
    ])
  })

  test("projects live streaming, native image attachments, and unknown tool state without invented facts", () => {
    const ref = { runtimeScope: "scope_1", threadID: "thread-1", turnID: "turn-active" }
    const active: CodexThreadSnapshot = {
      ...snapshot,
      turnOrder: ["turn-active"],
      turns: [
        {
          ...snapshot.turns[0]!,
          id: "turn-active",
          ref,
          status: "inProgress",
          itemOrder: ["user-images", "agent-stream", "tool-future"],
          items: [
            projectItem(
              {
                type: "userMessage",
                id: "user-images",
                content: [
                  { type: "text", text: "inspect these", text_elements: [] },
                  { type: "image", url: "https://example.com/screenshot.png" },
                  { type: "localImage", path: "/workspace/local.png" },
                  { type: "image", url: "javascript:alert(1)" },
                ],
              },
              ref,
            ),
            projectItem({ type: "agentMessage", id: "agent-stream", text: "working", phase: "commentary" }, ref),
            projectItem(
              {
                type: "mcpToolCall",
                id: "tool-future",
                server: "example",
                tool: "lookup",
                status: "waitingOnServer",
                arguments: { query: "x" },
                result: { content: [{ type: "text", text: "partial output" }] },
                error: null,
              },
              ref,
            ),
          ],
        },
      ],
      usage: { status: "unavailable" },
    }
    const view = projectCodexView(active, { sessionID })
    const user = view.messages[0]
    const assistant = view.messages[1]
    const tool = view.messages[2]

    expect(user?.type === "user" ? user.files : undefined).toEqual([
      { uri: "https://example.com/screenshot.png", mime: "image/*" },
      { uri: "file:///workspace/local.png", mime: "image/png" },
    ])
    expect(assistant).toMatchObject({ type: "assistant", streaming: true, time: {} })
    expect(assistant && "model" in assistant).toBe(false)
    expect(assistant && "agent" in assistant).toBe(false)
    expect(tool?.type === "assistant" ? tool.content[0] : undefined).toMatchObject({
      type: "tool",
      state: {
        status: "unknown",
        input: JSON.stringify({ query: "x" }),
        output: JSON.stringify({ content: [{ type: "text", text: "partial output" }] }),
        nativeStatus: "waitingOnServer",
      },
    })
    expect(tool?.metadata?.codex).toMatchObject({ nativeStatus: "waitingOnServer" })
    expect(view.usage).toEqual({ status: "unavailable" })
    expect(view.contextTokens).toEqual({ status: "unavailable" })
  })

  test("keeps rollout messages final and maps recorded image content without synthesizing facts", () => {
    const history = rolloutHistory()
    history.turns[0]!.items = [
      {
        ...history.turns[0]!.items[0]!,
        value: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "first steer" },
            { type: "input_image", image_url: "data:image/png;base64,AA==" },
          ],
        },
      },
      {
        id: "rollout-assistant",
        nativeID: "rollout-assistant",
        identity: "native",
        orderKey: "002",
        turnID: "turn-1",
        recordType: "response_item",
        nativeType: "message",
        kind: "message",
        role: "assistant",
        text: "done",
        value: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      },
    ]
    history.turns[0]!.itemOrder = history.turns[0]!.items.map((item) => item.id)
    const view = projectCodexRolloutView(history, { sessionID })
    const user = view.messages[0]
    const assistant = view.messages[1]

    expect(user?.type === "user" ? user.files : undefined).toEqual([
      { uri: "data:image/png;base64,AA==", mime: "image/png" },
    ])
    expect(assistant).toMatchObject({ type: "assistant", streaming: false, time: {} })
    expect(assistant && "model" in assistant).toBe(false)
    expect(assistant && "agent" in assistant).toBe(false)
    expect(view.usage).toEqual({ status: "unavailable" })
    expect(view.contextTokens).toEqual({ status: "unavailable" })
  })

  test("separates cumulative rollout usage from last-turn context occupancy", () => {
    const history = rolloutHistory()
    history.turns[0]!.usage = [
      {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 90,
            input_tokens: 50,
            output_tokens: 20,
            reasoning_output_tokens: 10,
            cached_input_tokens: 8,
            cache_write_input_tokens: 2,
          },
          last_token_usage: { total_tokens: 9 },
        },
      },
    ]
    history.turns[0]!.contextWindows = [100]
    const view = projectCodexRolloutView(history, { sessionID })

    expect(view.usage).toEqual({
      status: "available",
      value: { total: 90, input: 50, output: 20, reasoning: 10, cache: { read: 8, write: 2 } },
    })
    expect(view.contextTokens).toEqual({ status: "available", value: 9 })
    expect(view.contextWindow).toEqual({ status: "available", value: 100 })
  })

  test("requires an explicit map to close live and rollout identity", () => {
    const rollout = rolloutHistory()
    const liveKey = codexViewIdentityKey("scope_1", "thread-1", "turn-1", "live-user")
    const rolloutKey = codexViewIdentityKey("scope_1", "thread-1", "turn-1", "rollout-user")
    const identityMap = {
      canonicalItemIDByKey: {
        [liveKey]: "canonical-user",
        [rolloutKey]: "canonical-user",
      },
    }
    const live = projectCodexView(snapshot, { sessionID, identityMap })
    const restored = projectCodexRolloutView(rollout, { sessionID, identityMap })
    expect(restored.messages[0]?.id).toBe(live.messages[0]?.id)
    expect(restored.messages[0]?.orderKey).toBe(live.messages[0]?.orderKey)
    expect(restored.identities.unmatchedRolloutKeys).toEqual([])
    expect(projectCodexRolloutView(rollout, { sessionID }).identities.unmatchedRolloutKeys).toEqual([rolloutKey])
  })

  test("keeps unknown unified diff payload inspectable", () => {
    expect(unifiedDiffs("+one\n-two\n")).toEqual([{ patch: "+one\n-two\n", additions: 1, deletions: 1 }])
  })
})

function rolloutHistory(): CodexRolloutHistory {
  return {
    runtimeScope: "scope_1",
    threadID: "thread-1",
    path: "/isolated/home/sessions/rollout.jsonl",
    sessionMeta: { id: "thread-1" },
    turnOrder: ["turn-projected"],
    turns: [
      {
        id: "turn-projected",
        nativeID: "turn-1",
        orderKey: "turn-order",
        observedStatus: "completed",
        itemOrder: ["rollout-item"],
        items: [
          {
            id: "rollout-item",
            nativeID: "rollout-user",
            identity: "native",
            orderKey: "001",
            turnID: "turn-1",
            recordType: "response_item",
            nativeType: "message",
            kind: "message",
            role: "user",
            text: "first steer",
            value: { type: "message", role: "user" },
          },
        ],
        usage: [],
        diffs: [],
        contextWindows: [],
      },
    ],
    unassignedItems: [],
    invalidLineCount: 0,
  }
}
