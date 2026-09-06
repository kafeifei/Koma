import type { ServerNotification } from "./protocol/generated/ServerNotification.js"
import type { Thread } from "./protocol/generated/v2/Thread.js"
import type { ThreadItem } from "./protocol/generated/v2/ThreadItem.js"
import type { ThreadTokenUsage } from "./protocol/generated/v2/ThreadTokenUsage.js"
import type { Turn } from "./protocol/generated/v2/Turn.js"

export type BrowserValue = null | boolean | number | string | BrowserValue[] | { [key: string]: BrowserValue }

export type ProjectionAvailability<Value> =
  | { status: "available"; value: Value }
  | { status: "unavailable" }
  | { status: "loading" }

export type CodexNativeReference = {
  runtimeScope: string
  threadID: string
  turnID?: string
  itemID?: string
}

export type CodexProjectedContent =
  | {
      type: "message"
      role: "user" | "assistant" | "system"
      text: string
      phase?: string
      attachments?: BrowserValue[]
    }
  | { type: "reasoning"; summary: string[]; content: string[] }
  | { type: "plan"; text: string }
  | {
      type: "tool"
      name: string
      status?: string
      input?: BrowserValue
      output?: BrowserValue
      error?: BrowserValue
      durationMs?: number
    }
  | {
      type: "command"
      command: string
      cwd: string
      status: string
      output?: string
      exitCode?: number
      durationMs?: number
    }
  | { type: "fileChange"; status: string; changes: BrowserValue[] }
  | {
      type: "subagent"
      operation: string
      status?: string
      senderThreadID?: string
      receiverThreadIDs: string[]
      prompt?: string
      agentThreadID?: string
      agentPath?: string
    }
  | { type: "compaction" }
  | { type: "asset"; assetType: string; value: BrowserValue }
  | { type: "unknown"; nativeType: string; value: BrowserValue }

export type CodexProjectedItem = {
  id: string
  orderKey: string
  ref: CodexNativeReference
  identity: "native" | "derived"
  nativeType: string
  time?: { created?: number; completed?: number; ran?: number }
  content: CodexProjectedContent
}

export type CodexProjectedTurn = {
  id: string
  orderKey: string
  ref: CodexNativeReference
  status: string
  error: BrowserValue | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  itemOrder: string[]
  items: CodexProjectedItem[]
  diff: ProjectionAvailability<string>
}

export type CodexThreadSnapshot = {
  runtimeScope: string
  revision: number
  thread: {
    id: string
    sessionID: string
    parentThreadID: string | null
    forkedFromID: string | null
    cwd: string
    name: string | null
    preview: string
    model: string | null
    reasoningEffort: string | null
    status: string
    createdAt: number
    updatedAt: number
    recencyAt: number | null
  }
  turnOrder: string[]
  turns: CodexProjectedTurn[]
  usage: ProjectionAvailability<BrowserValue>
}

export type CodexProjectionOptions = {
  runtimeScope: string
  revision: number
  usage?: ProjectionAvailability<ThreadTokenUsage>
  turnDiffs?: Readonly<Record<string, ProjectionAvailability<string>>>
  itemTimes?: Readonly<Record<string, { created?: number; completed?: number; ran?: number }>>
}

export type CodexProjectionUpdate =
  | { type: "turnUpsert"; threadID: string; turn: CodexProjectedTurn }
  | {
      type: "itemUpsert"
      threadID: string
      turnID: string
      item: CodexProjectedItem
      startedAtMs?: number
      completedAtMs?: number
    }
  | {
      type: "itemAppend"
      threadID: string
      turnID: string
      itemID: string
      field: "message" | "plan" | "commandOutput" | "reasoningSummary" | "reasoningContent"
      index?: number
      text: string
    }
  | { type: "fileChangesReplace"; threadID: string; turnID: string; itemID: string; changes: BrowserValue[] }
  | { type: "turnDiffReplace"; threadID: string; turnID: string; diff: string }
  | { type: "usageReplace"; threadID: string; turnID: string; usage: BrowserValue }
  | { type: "compaction"; threadID: string; turnID: string }
  | { type: "queueChanged"; threadID: string }
  | { type: "threadStatusChanged"; threadID: string; status: string }
  | { type: "unknown"; method: string; value: BrowserValue }

export function projectThread(thread: Thread, options: CodexProjectionOptions): CodexThreadSnapshot {
  const turns = thread.turns.map((turn) =>
    projectTurn(turn, options.runtimeScope, thread.id, options.turnDiffs?.[turn.id], options.itemTimes),
  )
  return {
    runtimeScope: options.runtimeScope,
    revision: options.revision,
    thread: {
      id: thread.id,
      sessionID: thread.sessionId,
      parentThreadID: thread.parentThreadId,
      forkedFromID: thread.forkedFromId,
      cwd: thread.cwd,
      name: thread.name,
      preview: thread.preview,
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
      status: thread.status.type,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      recencyAt: thread.recencyAt,
    },
    turnOrder: turns.map((turn) => turn.id),
    turns,
    usage: options.usage ? mapUsageAvailability(options.usage) : { status: "unavailable" },
  }
}

export function projectTurn(
  turn: Turn,
  runtimeScope: string,
  threadID: string,
  diff: ProjectionAvailability<string> = { status: "unavailable" },
  itemTimes?: CodexProjectionOptions["itemTimes"],
): CodexProjectedTurn {
  const ref = { runtimeScope, threadID, turnID: turn.id }
  const items = turn.items.map((item) => {
    const projected = projectItem(item, ref)
    const time = itemTimes?.[projected.id]
    return time ? { ...projected, time } : projected
  })
  return {
    id: stableProjectionID("turn", runtimeScope, turn.id),
    orderKey: stableProjectionID("order", runtimeScope, turn.id),
    ref,
    status: turn.status,
    error: turn.error ? toBrowserValue(turn.error) : null,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    itemOrder: items.map((item) => item.id),
    items,
    diff,
  }
}

export function projectItem(
  item: ThreadItem | unknown,
  ref: Omit<CodexNativeReference, "itemID">,
  time?: CodexProjectedItem["time"],
): CodexProjectedItem {
  const record = isRecord(item) ? item : { type: "unknown", value: item }
  const nativeType = typeof record.type === "string" ? record.type : "unknown"
  const identity = typeof record.id === "string" ? "native" : "derived"
  const itemID = identity === "native" ? string(record.id) : stableUnknownID(record)
  const fullRef = { ...ref, itemID }
  return {
    id: stableProjectionID("item", ref.runtimeScope, ref.threadID, ref.turnID ?? "", itemID),
    orderKey: stableProjectionID("order", ref.runtimeScope, ref.threadID, ref.turnID ?? "", itemID),
    ref: fullRef,
    identity,
    nativeType,
    ...(time ? { time } : {}),
    content: projectContent(record, nativeType),
  }
}

export function projectNotification(
  notification: ServerNotification | { method: string; params?: unknown },
  runtimeScope: string,
): CodexProjectionUpdate {
  const params = isRecord(notification.params) ? notification.params : {}
  const threadID = string(params.threadId)
  const turnID = string(params.turnId)
  const itemID = string(params.itemId)
  if (notification.method === "turn/started" || notification.method === "turn/completed") {
    const turn = params.turn
    if (isTurn(turn) && threadID) {
      return { type: "turnUpsert", threadID, turn: projectTurnForThread(turn, runtimeScope, threadID) }
    }
  }
  if (notification.method === "item/started" || notification.method === "item/completed") {
    if (threadID && turnID && isRecord(params.item)) {
      return {
        type: "itemUpsert",
        threadID,
        turnID,
        item: projectItem(
          params.item,
          { runtimeScope, threadID, turnID },
          {
            ...(typeof params.startedAtMs === "number" ? { created: params.startedAtMs } : {}),
            ...(typeof params.completedAtMs === "number" ? { completed: params.completedAtMs } : {}),
          },
        ),
        ...(typeof params.startedAtMs === "number" ? { startedAtMs: params.startedAtMs } : {}),
        ...(typeof params.completedAtMs === "number" ? { completedAtMs: params.completedAtMs } : {}),
      }
    }
  }
  const append = appendUpdate(notification.method, params, threadID, turnID, itemID)
  if (append) return append
  if (notification.method === "item/fileChange/patchUpdated" && threadID && turnID && itemID) {
    return {
      type: "fileChangesReplace",
      threadID,
      turnID,
      itemID,
      changes: Array.isArray(params.changes) ? params.changes.map(toBrowserValue) : [],
    }
  }
  if (notification.method === "turn/diff/updated" && threadID && turnID && typeof params.diff === "string") {
    return { type: "turnDiffReplace", threadID, turnID, diff: params.diff }
  }
  if (notification.method === "thread/tokenUsage/updated" && threadID && turnID) {
    return { type: "usageReplace", threadID, turnID, usage: toBrowserValue(params.tokenUsage) }
  }
  if (notification.method === "thread/compacted" && threadID && turnID) {
    return { type: "compaction", threadID, turnID }
  }
  if (notification.method === "thread/queue/changed" && threadID) return { type: "queueChanged", threadID }
  if (notification.method === "thread/status/changed" && threadID && isRecord(params.status)) {
    return { type: "threadStatusChanged", threadID, status: string(params.status.type) || "unknown" }
  }
  return { type: "unknown", method: notification.method, value: toBrowserValue(notification.params) }
}

export function stableProjectionID(kind: "turn" | "item" | "order", ...parts: string[]) {
  return `codex_${kind}_${parts.map((part) => encodeURIComponent(part)).join("_")}`
}

function projectTurnForThread(turn: Turn, runtimeScope: string, threadID: string) {
  return projectTurn(turn, runtimeScope, threadID)
}

function projectContent(item: Record<string, unknown>, nativeType: string): CodexProjectedContent {
  if (nativeType === "userMessage") {
    const content = Array.isArray(item.content) ? item.content : []
    return {
      type: "message",
      role: "user",
      text: content
        .filter((input) => isRecord(input) && input.type === "text" && typeof input.text === "string")
        .map((input) => string(input.text))
        .join("\n"),
      attachments: content.filter((input) => !isRecord(input) || input.type !== "text").map(toBrowserValue),
    }
  }
  if (nativeType === "agentMessage") {
    return {
      type: "message",
      role: "assistant",
      text: string(item.text),
      ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
    }
  }
  if (nativeType === "hookPrompt") {
    return { type: "message", role: "system", text: "", attachments: [toBrowserValue(item.fragments)] }
  }
  if (nativeType === "reasoning") {
    return {
      type: "reasoning",
      summary: strings(item.summary),
      content: strings(item.content),
    }
  }
  if (nativeType === "plan") return { type: "plan", text: string(item.text) }
  if (nativeType === "commandExecution") {
    return {
      type: "command",
      command: string(item.command),
      cwd: string(item.cwd),
      status: string(item.status) || "unknown",
      ...(typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    }
  }
  if (nativeType === "fileChange") {
    return {
      type: "fileChange",
      status: string(item.status) || "unknown",
      changes: Array.isArray(item.changes) ? item.changes.map(toBrowserValue) : [],
    }
  }
  if (nativeType === "collabAgentToolCall") {
    return {
      type: "subagent",
      operation: string(item.tool) || nativeType,
      ...(string(item.status) ? { status: string(item.status) } : {}),
      ...(string(item.senderThreadId) ? { senderThreadID: string(item.senderThreadId) } : {}),
      receiverThreadIDs: strings(item.receiverThreadIds),
      ...(string(item.prompt) ? { prompt: string(item.prompt) } : {}),
    }
  }
  if (nativeType === "subAgentActivity") {
    return {
      type: "subagent",
      operation: string(item.kind) || nativeType,
      receiverThreadIDs: [],
      ...(string(item.agentThreadId) ? { agentThreadID: string(item.agentThreadId) } : {}),
      ...(string(item.agentPath) ? { agentPath: string(item.agentPath) } : {}),
    }
  }
  if (nativeType === "contextCompaction") return { type: "compaction" }
  if (nativeType === "mcpToolCall" || nativeType === "dynamicToolCall" || nativeType === "functionCallOutput") {
    return {
      type: "tool",
      name: string(item.tool) || string(item.name) || nativeType,
      status: string(item.status) || undefined,
      input: item.arguments === undefined ? undefined : toBrowserValue(item.arguments),
      output:
        item.result === undefined && item.output === undefined ? undefined : toBrowserValue(item.result ?? item.output),
      error: item.error === undefined || item.error === null ? undefined : toBrowserValue(item.error),
      durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
    }
  }
  if (
    ["webSearch", "imageView", "imageGeneration", "sleep", "enteredReviewMode", "exitedReviewMode"].includes(nativeType)
  ) {
    return { type: "asset", assetType: nativeType, value: toBrowserValue(item) }
  }
  return { type: "unknown", nativeType, value: toBrowserValue(item) }
}

function appendUpdate(
  method: string,
  params: Record<string, unknown>,
  threadID: string,
  turnID: string,
  itemID: string,
): CodexProjectionUpdate | undefined {
  if (!threadID || !turnID || !itemID || typeof params.delta !== "string") return
  const fields: Record<string, "message" | "plan" | "commandOutput" | "reasoningSummary" | "reasoningContent"> = {
    "item/agentMessage/delta": "message",
    "item/plan/delta": "plan",
    "item/commandExecution/outputDelta": "commandOutput",
    "item/reasoning/summaryTextDelta": "reasoningSummary",
    "item/reasoning/textDelta": "reasoningContent",
  }
  const field = fields[method]
  if (!field) return
  return {
    type: "itemAppend",
    threadID,
    turnID,
    itemID,
    field,
    ...(typeof params.summaryIndex === "number"
      ? { index: params.summaryIndex }
      : typeof params.contentIndex === "number"
        ? { index: params.contentIndex }
        : {}),
    text: params.delta,
  }
}

function mapUsageAvailability<Value>(
  availability: ProjectionAvailability<Value>,
): ProjectionAvailability<BrowserValue> {
  if (availability.status !== "available") return availability
  return { status: "available", value: toBrowserValue(availability.value) }
}

export function toBrowserValue(value: unknown): BrowserValue {
  if (value === undefined) return null
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (Array.isArray(value)) return value.map(toBrowserValue)
  if (!isRecord(value)) return String(value)
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .map((entry) => [entry[0], toBrowserValue(entry[1])]),
  )
}

function stableUnknownID(value: Record<string, unknown>) {
  return `unknown-${hash(JSON.stringify(toBrowserValue(value)))}`
}

function hash(value: string) {
  return Array.from(value)
    .reduce((result, character) => Math.imul(result ^ character.charCodeAt(0), 16_777_619), 2_166_136_261)
    .toString(36)
}

function isTurn(value: unknown): value is Turn {
  return (
    isRecord(value) && typeof value.id === "string" && Array.isArray(value.items) && typeof value.status === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function string(value: unknown) {
  return typeof value === "string" ? value : ""
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
