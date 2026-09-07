import { describe, expect, test } from "bun:test"
import type { Message, Part, Session, ToolPart } from "@opencode-ai/sdk/v2"
import {
  childSessionStatus,
  discoverChildSessions,
  inspectorTools,
  rawToolDetail,
  relatedChildSessions,
  sessionStatus,
  taskSessionID,
  toolStatus,
  visibleMessage,
} from "./inspector-data"

const message = (id: string, role: "user" | "assistant" = "assistant"): Message => {
  if (role === "user")
    return {
      id,
      sessionID: "root",
      role,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
  return {
    id,
    sessionID: "root",
    role,
    time: { created: 1 },
    parentID: "user",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

const tool = (
  id: string,
  status: ToolPart["state"]["status"] = "completed",
  sessionId?: string,
  name = sessionId ? "task" : "bash",
): ToolPart => {
  const state: ToolPart["state"] =
    status === "completed"
      ? {
          status,
          input: {},
          output: "done",
          title: "Done",
          metadata: sessionId ? { sessionId } : {},
          time: { start: 1, end: 2 },
        }
      : status === "error"
        ? { status, input: {}, error: "failed", metadata: sessionId ? { sessionId } : {}, time: { start: 1, end: 2 } }
        : status === "running"
          ? { status, input: {}, metadata: sessionId ? { sessionId } : {}, time: { start: 1 } }
          : { status, input: {}, raw: "" }
  return {
    id,
    sessionID: "root",
    messageID: "m1",
    callID: id,
    type: "tool",
    tool: name,
    state,
  }
}

const session = (id: string, parentID?: string, archived?: number, updated = 2): Session => ({
  id,
  slug: id,
  projectID: "project",
  parentID,
  title: id,
  directory: "/repo",
  version: "1",
  time: { created: 1, updated, archived },
})

describe("inspector data", () => {
  test("discovers cold-cache V1 descendants through the children endpoint", async () => {
    const calls: string[] = []
    const result = await discoverChildSessions({
      rootID: "root",
      protocol: Promise.resolve("v1"),
      signal: new AbortController().signal,
      children: async (id) => {
        calls.push(id)
        if (id === "root") return [session("child", "root")]
        if (id === "child") return [session("grandchild", "child", 4)]
        return []
      },
      list: async () => ({ data: [] }),
    })
    expect(calls).toEqual(["root", "child", "grandchild"])
    expect(result.map((item) => item.id).sort()).toEqual(["child", "grandchild"])
  })

  test("discovers V2 descendants across pages without returning unrelated sessions", async () => {
    const result = await discoverChildSessions({
      rootID: "root",
      protocol: Promise.resolve("v2"),
      signal: new AbortController().signal,
      children: async () => [],
      list: async (cursor) =>
        cursor
          ? { data: [session("child", "root"), session("other", "elsewhere")] }
          : { data: [session("grandchild", "child", 4)], cursor: "next" },
    })
    expect(result.map((item) => item.id).sort()).toEqual(["child", "grandchild"])
  })

  test("lists real tools and keeps task metadata identity", () => {
    const task = tool("task", "running", "child")
    const step: Part = { id: "step", sessionID: "root", messageID: "m1", type: "step-start" }
    const items = inspectorTools([message("m1")], { m1: [task, step] })
    expect(items).toEqual([{ messageID: "m1", part: task }])
    expect(taskSessionID(task)).toBe("child")
    expect(toolStatus(task)).toBe("running")
  })

  test("keeps Codex subagent identities from metadata and pending native input", () => {
    expect(taskSessionID(tool("native", "completed", "child", "codex.subagent"))).toBe("child")
    expect(
      taskSessionID({
        ...tool("pending", "pending", undefined, "codex.subagent"),
        state: {
          status: "pending",
          input: { nativeSubagent: true, sessionId: "pending-child" },
          raw: '{"nativeSubagent":true,"sessionId":"pending-child"}',
        },
      }),
    ).toBe("pending-child")
  })

  test("keeps completed and archived descendants scoped to the root", () => {
    const task = tool("task", "completed", "evicted-child")
    const sessions = {
      root: session("root"),
      child: session("child", "root"),
      grandchild: session("grandchild", "child", 4, 1),
      other: session("other", "elsewhere"),
      referenced: session("evicted-child", "missing", 5, 3),
    }
    expect(relatedChildSessions("root", sessions, [{ messageID: "m1", part: task }]).map((item) => item.id)).toEqual([
      "evicted-child",
      "child",
      "grandchild",
    ])
  })

  test("does not infer success from idle and filters structural-only messages", () => {
    expect(sessionStatus(undefined)).toBe("unknown")
    expect(sessionStatus({ type: "idle" })).toBe("idle")
    expect(childSessionStatus(session("archived", "root", 4), { type: "idle" })).toBe("archived")
    expect(
      visibleMessage(message("m1"), [{ id: "step", sessionID: "root", messageID: "m1", type: "step-start" }]),
    ).toBe(false)
    expect(
      visibleMessage(message("u1", "user"), [
        { id: "file", sessionID: "root", messageID: "u1", type: "file", url: "file://x", mime: "text/plain" },
      ]),
    ).toBe(true)
  })

  test("falls back for read and generic outputs without duplicating rich renderers", () => {
    const task = tool("task", "completed", "child")
    expect(rawToolDetail(task)).toEqual({ type: "output", text: "done" })
    expect(rawToolDetail(tool("bash"))).toBeUndefined()
    expect(rawToolDetail(tool("read", "completed", undefined, "read"))).toEqual({ type: "output", text: "done" })
    expect(rawToolDetail(tool("custom", "completed", undefined, "custom_mcp"))).toEqual({
      type: "output",
      text: "done",
    })
    expect(rawToolDetail(tool("custom", "completed", undefined, "custom_mcp"), true)).toBeUndefined()
  })

  test("keeps native fallback input and failed output inspectable with registered renderers", () => {
    expect(rawToolDetail(tool("search", "completed", undefined, "codex.webSearch"), true)).toBeUndefined()
    const patch = tool("patch", "completed", undefined, "codex.fileChange")
    if (!("metadata" in patch.state)) throw new Error("Expected completed metadata")
    patch.state.metadata = { output: "raw patch output" }
    expect(rawToolDetail(patch, true)).toBeUndefined()
    expect(rawToolDetail(tool("command", "running", undefined, "codex.commandExecution"), true)).toBeUndefined()
    expect(
      rawToolDetail(
        {
          ...tool("pending", "pending", undefined, "codex.webSearch"),
          state: { status: "pending", input: {}, raw: '{"query":"native state"}' },
        },
        true,
      ),
    ).toEqual({
      type: "input",
      text: '{"query":"native state"}',
    })

    const failed = tool("failed", "error", undefined, "codex.commandExecution")
    if (!("metadata" in failed.state)) throw new Error("Expected error metadata")
    failed.state.metadata = { output: "stdout before failure" }
    expect(rawToolDetail(failed, true)).toEqual({ type: "output", text: "stdout before failure" })
  })
})
