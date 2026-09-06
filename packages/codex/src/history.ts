import { createReadStream } from "node:fs"
import { realpath } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { stableProjectionID, toBrowserValue } from "./projection.js"
import type { BrowserValue } from "./projection.js"

export type CodexRolloutItemKind = "message" | "reasoning" | "tool" | "compaction" | "unknown" | "invalid"

export type CodexRolloutItem = {
  id: string
  nativeID: string
  identity: "native" | "derived"
  orderKey: string
  turnID: string
  recordType: string
  nativeType: string
  kind: CodexRolloutItemKind
  role?: string
  text?: string
  timestamp?: string
  value: BrowserValue
}

export type CodexRolloutTurn = {
  id: string
  nativeID: string
  orderKey: string
  observedStatus: "active" | "completed" | "interrupted" | "failed" | "unknown"
  itemOrder: string[]
  items: CodexRolloutItem[]
  usage: BrowserValue[]
  diffs: string[]
  contextWindows: number[]
}

export type CodexRolloutHistory = {
  runtimeScope: string
  threadID: string
  path: string
  sessionMeta: BrowserValue
  turnOrder: string[]
  turns: CodexRolloutTurn[]
  unassignedItems: CodexRolloutItem[]
  invalidLineCount: number
}

export type ReadCodexRolloutOptions = {
  codexHome: string
  path: string
  expectedThreadID: string
  runtimeScope: string
}

type MutableTurn = Omit<CodexRolloutTurn, "itemOrder"> & { itemOrder: string[] }

/**
 * Reads one exact app-server-owned rollout. The caller supplies the path from
 * a trusted `thread/read` binding; this function never scans Codex homes or
 * guesses a thread from cwd/title. Both real paths are checked so a symlink
 * cannot escape `<codexHome>/sessions`, and session metadata must name the
 * expected bound thread before any content is returned.
 *
 * The result is a read-only record projection. It does not synthesize Codex
 * `ThreadItem`s, write the rollout, resume the thread, or create model work.
 * `observedStatus` only reports markers present in the file and must not be
 * used as current runtime status after a process restart.
 */
export async function readCodexRolloutHistory(options: ReadCodexRolloutOptions): Promise<CodexRolloutHistory> {
  const codexHome = await realpath(options.codexHome)
  const path = await realpath(options.path)
  const sessions = resolve(codexHome, "sessions")
  const location = relative(sessions, path)
  if (!location || location === ".." || location.startsWith(`..${sep}`) || resolve(sessions, location) !== path) {
    throw new Error(`Codex rollout is outside the injected home: ${path}`)
  }
  const turns = new Map<string, MutableTurn>()
  const unassignedItems: CodexRolloutItem[] = []
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })
  let currentTurnID: string | undefined
  let sessionMeta: BrowserValue = null
  let discoveredThreadID: string | undefined
  let invalidLineCount = 0
  let lineNumber = 0

  for await (const line of lines) {
    lineNumber++
    if (!line.trim()) continue
    const record = parseRecord(line)
    if (!record) {
      invalidLineCount++
      unassignedItems.push(invalidItem(options, line, lineNumber))
      continue
    }
    const payload = isRecord(record.payload) ? record.payload : {}
    if (record.type === "session_meta") {
      const threadID = string(payload.id) || string(payload.session_id)
      if (threadID) discoveredThreadID = threadID
      sessionMeta = toBrowserValue(payload)
      continue
    }
    const recordType = string(record.type)
    const messageMetadata = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : {}
    const explicitTurnID =
      string(payload.turn_id) || string(record.turn_id) || string(messageMetadata.turn_id)
    if (recordType === "turn_context" && explicitTurnID) currentTurnID = explicitTurnID
    if (recordType === "event_msg" && payload.type === "task_started" && explicitTurnID) currentTurnID = explicitTurnID
    const turnID = explicitTurnID || currentTurnID
    if (turnID) {
      const turn = getTurn(turns, options.runtimeScope, options.expectedThreadID, turnID)
      updateTurn(turn, recordType, payload)
      const item = rolloutItem(options, record, payload, turnID, lineNumber)
      if (item) {
        turn.items.push(item)
        turn.itemOrder.push(item.id)
      }
      const usage = usageRecord(recordType, payload)
      if (usage !== undefined) turn.usage.push(usage)
      const diff = diffRecord(recordType, payload)
      if (diff !== undefined) turn.diffs.push(diff)
      const contextWindow = contextWindowRecord(recordType, payload)
      if (contextWindow !== undefined) turn.contextWindows.push(contextWindow)
      continue
    }
    const item = rolloutItem(options, record, payload, "unassigned", lineNumber)
    if (item) unassignedItems.push(item)
  }
  if (!discoveredThreadID) throw new Error(`Codex rollout has no session_meta identity: ${path}`)
  if (discoveredThreadID !== options.expectedThreadID) {
    throw new Error(`Codex rollout identity mismatch: expected ${options.expectedThreadID}, got ${discoveredThreadID}`)
  }
  const projectedTurns = [...turns.values()]
  return {
    runtimeScope: options.runtimeScope,
    threadID: discoveredThreadID,
    path,
    sessionMeta,
    turnOrder: projectedTurns.map((turn) => turn.id),
    turns: projectedTurns,
    unassignedItems,
    invalidLineCount,
  }
}

function getTurn(turns: Map<string, MutableTurn>, runtimeScope: string, threadID: string, turnID: string) {
  const existing = turns.get(turnID)
  if (existing) return existing
  const turn: MutableTurn = {
    id: stableProjectionID("turn", runtimeScope, threadID, turnID),
    nativeID: turnID,
    orderKey: stableProjectionID("order", runtimeScope, threadID, turnID),
    observedStatus: "unknown",
    itemOrder: [],
    items: [],
    usage: [],
    diffs: [],
    contextWindows: [],
  }
  turns.set(turnID, turn)
  return turn
}

function updateTurn(turn: MutableTurn, recordType: string, payload: Record<string, unknown>) {
  if (recordType !== "event_msg") return
  const type = string(payload.type)
  if (type === "task_started") turn.observedStatus = "active"
  if (["task_complete", "task_completed", "turn_complete", "turn_completed"].includes(type)) {
    turn.observedStatus = "completed"
  }
  if (["turn_aborted", "task_interrupted", "turn_interrupted"].includes(type)) turn.observedStatus = "interrupted"
  if (["task_failed", "turn_failed", "error"].includes(type)) turn.observedStatus = "failed"
}

function rolloutItem(
  options: ReadCodexRolloutOptions,
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  turnID: string,
  lineNumber: number,
): CodexRolloutItem | undefined {
  if (record.type !== "response_item") return
  const nativeType = string(payload.type) || "unknown"
  const declaredID = string(payload.id) || string(payload.call_id)
  const nativeID = declaredID || `line-${lineNumber}`
  const id = stableProjectionID("item", options.runtimeScope, options.expectedThreadID, turnID, nativeID)
  const ordinal = typeof record.ordinal === "number" ? record.ordinal : lineNumber
  const message = nativeType === "message" ? messageContent(payload) : undefined
  return {
    id,
    nativeID,
    identity: declaredID ? "native" : "derived",
    orderKey: `${String(ordinal).padStart(16, "0")}:${id}`,
    turnID,
    recordType: record.type,
    nativeType,
    kind: itemKind(nativeType),
    ...(message?.role ? { role: message.role } : {}),
    ...(message?.text ? { text: message.text } : {}),
    ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
    value: toBrowserValue(payload),
  }
}

function messageContent(payload: Record<string, unknown>) {
  const role = string(payload.role)
  const content = Array.isArray(payload.content) ? payload.content : []
  const text = content
    .filter(isRecord)
    .flatMap((part) => {
      if (!["input_text", "output_text", "text"].includes(string(part.type))) return []
      return typeof part.text === "string" ? [part.text] : []
    })
    .join("\n")
  return { role, text }
}

function itemKind(type: string): CodexRolloutItemKind {
  if (type === "message") return "message"
  if (["reasoning", "reasoning_summary"].includes(type)) return "reasoning"
  if (["compaction", "context_compaction", "compaction_trigger"].includes(type)) return "compaction"
  if (
    [
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
      "local_shell_call",
      "web_search_call",
      "image_generation_call",
      "tool_search_output",
    ].includes(type)
  ) {
    return "tool"
  }
  return "unknown"
}

function usageRecord(recordType: string, payload: Record<string, unknown>) {
  if (recordType !== "event_msg" || !["token_count", "token_usage"].includes(string(payload.type))) return
  return toBrowserValue(payload)
}

function diffRecord(recordType: string, payload: Record<string, unknown>) {
  if (recordType !== "event_msg" || !["turn_diff", "turn_diff_updated"].includes(string(payload.type))) return
  return typeof payload.diff === "string" ? payload.diff : undefined
}

function contextWindowRecord(recordType: string, payload: Record<string, unknown>) {
  if (recordType !== "event_msg" || payload.type !== "task_started") return
  return typeof payload.model_context_window === "number" ? payload.model_context_window : undefined
}

function invalidItem(options: ReadCodexRolloutOptions, line: string, lineNumber: number): CodexRolloutItem {
  const id = stableProjectionID(
    "item",
    options.runtimeScope,
    options.expectedThreadID,
    "unassigned",
    `invalid-${lineNumber}`,
  )
  return {
    id,
    nativeID: `invalid-${lineNumber}`,
    identity: "derived",
    orderKey: `${String(lineNumber).padStart(16, "0")}:${id}`,
    turnID: "unassigned",
    recordType: "invalid",
    nativeType: "invalid",
    kind: "invalid",
    value: line,
  }
}

function parseRecord(line: string) {
  try {
    const value = JSON.parse(line) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function string(value: unknown) {
  return typeof value === "string" ? value : ""
}
