import { SessionExternal } from "@opencode-ai/schema/session-external"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import type { FileDiff } from "@opencode-ai/schema/file-diff"
import type { SessionID } from "@opencode-ai/schema/session-id"
import { extname, isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import type { CodexRolloutHistory, CodexRolloutItem } from "./history.js"
import { toBrowserValue } from "./projection.js"
import type {
  BrowserValue,
  CodexProjectedContent,
  CodexProjectedItem,
  CodexProjectedTurn,
  CodexThreadSnapshot,
  ProjectionAvailability,
} from "./projection.js"

export type CodexViewIdentityMap = {
  canonicalItemIDByKey: Readonly<Record<string, string>>
}

export type CodexViewOptions = {
  sessionID: SessionID
  identityMap?: CodexViewIdentityMap
  childSessions?: Readonly<Record<string, SessionID>>
  sessionDiff?: ProjectionAvailability<string>
}

export type CodexViewWireFields = Pick<
  SessionExternal.Snapshot,
  | "messages"
  | "messageOrder"
  | "partOrder"
  | "usage"
  | "contextWindow"
  | "contextTokens"
  | "cost"
  | "turnDiffs"
  | "sessionDiff"
>

export type CodexView = CodexViewWireFields & {
  identities: {
    sourceKeyByMessageID: Record<string, string>
    unmatchedKeys: string[]
    unmatchedRolloutKeys: string[]
  }
  nativeChildren: Array<{
    sourceItemID: string
    nativeThreadID: string
    parentNativeThreadID: string
    sessionID?: SessionID
  }>
}

export type ViewTokens = {
  total?: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type ViewAvailability<Value> =
  | { status: "available"; value: Value }
  | { status: "unavailable" }
  | { status: "loading" }

type ViewEntry = {
  message: SessionExternal.Message
  partIDs: string[]
  sourceKey: string
  unmatchedRollout: boolean
  unmatched: boolean
  children: CodexView["nativeChildren"]
}

export function projectCodexView(snapshot: CodexThreadSnapshot, options: CodexViewOptions): CodexView {
  const entries = snapshot.turns.flatMap((turn) =>
    turn.items.map((item) => liveEntry(snapshot.runtimeScope, snapshot.thread.id, turn, item, options)),
  )
  const usage = tokens(snapshot.usage)
  return makeView(entries, {
    usage,
    contextWindow: contextWindow(snapshot.usage),
    contextTokens: contextTokens(snapshot.usage),
    cost: { status: "unavailable" },
    turnDiffs: Object.fromEntries(
      snapshot.turns.map((turn) => [turn.ref.turnID ?? turn.id, diffAvailability(turn.diff)]),
    ),
    sessionDiff: diffAvailability(options.sessionDiff ?? { status: "unavailable" }),
  })
}

export function projectCodexRolloutView(history: CodexRolloutHistory, options: CodexViewOptions): CodexView {
  const entries = history.turns.flatMap((turn) =>
    turn.items.map((item) => rolloutEntry(history, turn.nativeID, item, options)),
  )
  const usage = latest(history.turns.flatMap((turn) => turn.usage))
  const window = latest(history.turns.flatMap((turn) => turn.contextWindows))
  return makeView(entries, {
    usage: usage === undefined ? { status: "unavailable" } : tokensFromValue(usage),
    contextWindow: typeof window === "number" ? { status: "available", value: window } : { status: "unavailable" },
    contextTokens: usage === undefined ? { status: "unavailable" } : contextTokensFromValue(usage),
    cost: { status: "unavailable" },
    turnDiffs: Object.fromEntries(
      history.turns.map((turn) => [
        turn.nativeID,
        turn.diffs.length
          ? { status: "available", value: unifiedDiffs(turn.diffs.at(-1) ?? "") }
          : { status: "unavailable" },
      ]),
    ),
    sessionDiff: diffAvailability(options.sessionDiff ?? { status: "unavailable" }),
  })
}

export const codexThreadSnapshotToView = projectCodexView
export const codexRolloutHistoryToView = projectCodexRolloutView

export function codexViewIdentityKey(runtimeScope: string, threadID: string, turnID: string, sourceItemID: string) {
  return [runtimeScope, threadID, turnID, sourceItemID].map(encodeURIComponent).join("/")
}

function liveEntry(
  runtimeScope: string,
  threadID: string,
  turn: CodexProjectedTurn,
  item: CodexProjectedItem,
  options: CodexViewOptions,
): ViewEntry {
  const turnID = item.ref.turnID ?? turn.ref.turnID ?? turn.id
  const sourceItemID = item.ref.itemID ?? item.id
  const sourceKey = codexViewIdentityKey(runtimeScope, threadID, turnID, sourceItemID)
  return contentEntry({
    sessionID: options.sessionID,
    source: "live",
    sourceKey,
    canonicalItemID: options.identityMap?.canonicalItemIDByKey[sourceKey] ?? sourceItemID,
    orderKey: item.orderKey,
    runtimeScope,
    threadID,
    turnID,
    sourceItemID,
    nativeType: item.nativeType,
    content: item.content,
    raw: item.content,
    time: item.time ?? {},
    streaming: turn.status === "inProgress",
    unmatchedRollout: false,
    unmatched: item.identity === "derived" && options.identityMap?.canonicalItemIDByKey[sourceKey] === undefined,
    childSessions: options.childSessions,
  })
}

function rolloutEntry(
  history: CodexRolloutHistory,
  turnID: string,
  item: CodexRolloutItem,
  options: CodexViewOptions,
): ViewEntry {
  const runtimeScope = history.runtimeScope
  const sourceKey = codexViewIdentityKey(runtimeScope, history.threadID, turnID, item.nativeID)
  const mapped = options.identityMap?.canonicalItemIDByKey[sourceKey]
  const time = item.timestamp ? epochTime(item.timestamp) : {}
  return contentEntry({
    sessionID: options.sessionID,
    source: "rollout",
    sourceKey,
    canonicalItemID: mapped ?? item.nativeID,
    orderKey: item.orderKey,
    runtimeScope,
    threadID: history.threadID,
    turnID,
    sourceItemID: item.nativeID,
    nativeType: item.nativeType,
    content: rolloutContent(item),
    raw: item.value,
    time,
    streaming: false,
    unmatchedRollout: mapped === undefined,
    unmatched: mapped === undefined,
    childSessions: options.childSessions,
  })
}

function contentEntry(input: {
  sessionID: SessionID
  source: "live" | "rollout"
  sourceKey: string
  canonicalItemID: string
  orderKey: string
  runtimeScope: string
  threadID: string
  turnID: string
  sourceItemID: string
  nativeType: string
  content: CodexProjectedContent
  raw: unknown
  time: { created?: number; completed?: number }
  streaming: boolean
  unmatchedRollout: boolean
  unmatched: boolean
  childSessions?: Readonly<Record<string, SessionID>>
}): ViewEntry {
  const messageID = externalMessageID(input.runtimeScope, input.threadID, input.turnID, input.canonicalItemID)
  const orderKey = externalOrderKey(input.runtimeScope, input.threadID, input.turnID, input.canonicalItemID)
  const metadata = {
    codex: {
      source: input.source,
      sessionID: input.sessionID,
      runtimeScope: input.runtimeScope,
      threadID: input.threadID,
      turnID: input.turnID,
      itemID: input.sourceItemID,
      nativeType: input.nativeType,
      ...(contentStatus(input.content) ? { nativeStatus: contentStatus(input.content) } : {}),
      identityKey: input.sourceKey,
      sourceOrderKey: input.orderKey,
      raw: toBrowserValue(input.raw),
    },
  }
  if (input.content.type === "message" && input.content.role === "user") {
    const files = imageAttachments(input.content.attachments)
    return {
      message: {
        id: messageID,
        type: "user",
        text: input.content.text,
        ...(files.length ? { files } : {}),
        metadata,
        orderKey,
        time: input.time,
      },
      partIDs: [],
      sourceKey: input.sourceKey,
      unmatchedRollout: input.unmatchedRollout,
      unmatched: input.unmatched,
      children: [],
    }
  }
  if (input.content.type === "message" && input.content.role === "system") {
    return {
      message: {
        id: messageID,
        type: "system",
        text: input.content.text,
        metadata,
        orderKey,
        time: input.time,
      },
      partIDs: [],
      sourceKey: input.sourceKey,
      unmatchedRollout: input.unmatchedRollout,
      unmatched: input.unmatched,
      children: [],
    }
  }
  const content = assistantContent(input, messageID)
  const children =
    input.content.type === "subagent"
      ? [
          ...(input.content.agentThreadID
            ? [
                {
                  sourceItemID: input.sourceItemID,
                  nativeThreadID: input.content.agentThreadID,
                  parentNativeThreadID: input.threadID,
                  ...(input.childSessions?.[input.content.agentThreadID]
                    ? { sessionID: input.childSessions[input.content.agentThreadID] }
                    : {}),
                },
              ]
            : []),
          ...input.content.receiverThreadIDs.map((nativeThreadID) => ({
            sourceItemID: input.sourceItemID,
            nativeThreadID,
            parentNativeThreadID: input.threadID,
            ...(input.childSessions?.[nativeThreadID] ? { sessionID: input.childSessions[nativeThreadID] } : {}),
          })),
        ]
      : []
  return {
    message: {
      id: messageID,
      type: "assistant",
      content,
      metadata,
      orderKey,
      time: input.time,
      streaming: input.streaming,
    },
    partIDs: content.map((part) => part.id),
    sourceKey: input.sourceKey,
    unmatchedRollout: input.unmatchedRollout,
    unmatched: input.unmatched,
    children,
  }
}

function assistantContent(
  input: Parameters<typeof contentEntry>[0],
  messageID: SessionMessage.ID,
): SessionExternal.Content[] {
  const partID = (index: number) => `${messageID}:part:${index}`
  if (input.content.type === "message") return [{ type: "text", id: partID(0), text: input.content.text }]
  if (input.content.type === "reasoning") {
    const parts = [...input.content.summary, ...input.content.content]
    return parts.map((text, index) => ({
      type: "reasoning",
      id: partID(index),
      text,
      ...(Object.keys(input.time).length ? { time: input.time } : {}),
    }))
  }
  if (input.content.type === "plan") {
    return [
      toolContent(
        partID(0),
        "codex.plan",
        { text: input.content.text },
        input.content.text,
        undefined,
        undefined,
        input.time,
      ),
    ]
  }
  if (input.content.type === "command") {
    return [
      toolContent(
        partID(0),
        "codex.commandExecution",
        { command: input.content.command, cwd: input.content.cwd },
        input.content.output,
        input.content.status,
        undefined,
        input.time,
        {
          ...(input.content.exitCode === undefined ? {} : { exitCode: input.content.exitCode }),
          ...(input.content.durationMs === undefined ? {} : { durationMs: input.content.durationMs }),
        },
      ),
    ]
  }
  if (input.content.type === "fileChange") {
    return [
      toolContent(
        partID(0),
        "codex.fileChange",
        { changes: input.content.changes },
        undefined,
        input.content.status,
        undefined,
        input.time,
      ),
    ]
  }
  if (input.content.type === "tool") {
    return [
      toolContent(
        partID(0),
        input.content.name,
        record(input.content.input),
        text(input.content.output),
        input.content.status,
        input.content.error,
        input.time,
      ),
    ]
  }
  if (input.content.type === "subagent") {
    return [
      toolContent(
        partID(0),
        "codex.subagent",
        input.content,
        input.content.prompt,
        input.content.status,
        undefined,
        input.time,
      ),
    ]
  }
  if (input.content.type === "compaction") {
    return [
      toolContent(
        partID(0),
        "codex.compaction",
        { nativeType: input.nativeType },
        undefined,
        undefined,
        undefined,
        input.time,
      ),
    ]
  }
  if (input.content.type === "asset") {
    return [
      toolContent(
        partID(0),
        `codex.${input.content.assetType}`,
        { value: input.content.value },
        undefined,
        undefined,
        undefined,
        input.time,
      ),
    ]
  }
  return [
    toolContent(
      partID(0),
      `codex.native.${input.content.nativeType}`,
      { value: input.content.value },
      undefined,
      undefined,
      undefined,
      input.time,
    ),
  ]
}

function toolContent(
  id: string,
  name: string,
  input: Record<string, unknown>,
  output?: string,
  nativeStatus?: string,
  nativeError?: unknown,
  time: { created?: number; completed?: number; ran?: number } = {},
  details: Record<string, unknown> = {},
): SessionExternal.Content {
  const content = output ? [{ type: "text" as const, text: output }] : []
  const structured = Object.fromEntries(
    Object.entries({ ...details, nativeStatus, nativeError }).filter((entry) => entry[1] !== undefined),
  )
  if (["pending", "inProgress", "running"].includes(nativeStatus ?? "")) {
    return { type: "tool", id, name, time, state: { status: "running", input, content, structured } }
  }
  if (
    ["failed", "error", "declined", "cancelled", "canceled", "interrupted"].includes(nativeStatus ?? "") ||
    nativeError !== undefined
  ) {
    return {
      type: "tool",
      id,
      name,
      time,
      state: {
        status: "error",
        input,
        content,
        structured,
        error: { type: "unknown", message: text(nativeError) || `Codex ${name} failed` },
      },
    }
  }
  if (nativeStatus === "completed") {
    return { type: "tool", id, name, time, state: { status: "completed", input, content, structured } }
  }
  return {
    type: "tool",
    id,
    name,
    time,
    state: {
      status: "unknown",
      input: JSON.stringify(input),
      ...(output === undefined ? {} : { output }),
      ...(nativeStatus === undefined ? {} : { nativeStatus }),
    },
  }
}

function contentStatus(content: CodexProjectedContent) {
  if (
    content.type === "command" ||
    content.type === "fileChange" ||
    content.type === "tool" ||
    content.type === "subagent"
  ) {
    return content.status
  }
}

function imageAttachments(values?: BrowserValue[]) {
  return (values ?? []).flatMap((value) => {
    const item = record(value)
    if (item.type === "localImage" && typeof item.path === "string") {
      const mime = localImageMime(item.path)
      if (!isAbsolute(item.path) || !mime) return []
      return [{ uri: pathToFileURL(item.path).href, mime }]
    }
    const uri = item.type === "input_image" ? item.image_url : item.type === "image" ? item.url : undefined
    if (typeof uri !== "string" || !URL.canParse(uri)) return []
    const parsed = new URL(uri)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return [{ uri, mime: "image/*" }]
    const mime = /^data:(image\/(?:png|jpeg|webp|gif|avif|heic));/i.exec(uri)?.[1]?.toLowerCase()
    return mime ? [{ uri, mime }] : []
  })
}

function localImageMime(path: string) {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".heic": "image/heic",
  }
  return types[extname(path).toLowerCase()]
}

function rolloutContent(item: CodexRolloutItem): CodexProjectedContent {
  if (item.kind === "message") {
    const role = item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : "system"
    const content = record(item.value).content
    return {
      type: "message",
      role,
      text: item.text ?? "",
      attachments: Array.isArray(content) ? content.map(toBrowserValue) : [],
    }
  }
  if (item.kind === "reasoning") {
    const value = record(item.value)
    return {
      type: "reasoning",
      summary: textValues(value.summary),
      content: textValues(value.content),
    }
  }
  if (item.kind === "compaction") return { type: "compaction" }
  if (item.kind === "tool") {
    const value = record(item.value)
    return {
      type: "tool",
      name: string(value.name) || item.nativeType,
      status: string(value.status) || undefined,
      input: item.value,
      output: value.output === undefined ? undefined : toBrowserValue(value.output),
    }
  }
  return { type: "unknown", nativeType: item.nativeType, value: item.value }
}

function makeView(
  entries: ViewEntry[],
  data: Pick<CodexView, "usage" | "contextWindow" | "contextTokens" | "cost" | "turnDiffs" | "sessionDiff">,
): CodexView {
  return {
    messages: entries.map((entry) => entry.message),
    messageOrder: entries.map((entry) => entry.message.id),
    partOrder: Object.fromEntries(entries.map((entry) => [entry.message.id, entry.partIDs])),
    ...data,
    identities: {
      sourceKeyByMessageID: Object.fromEntries(entries.map((entry) => [entry.message.id, entry.sourceKey])),
      unmatchedKeys: entries.filter((entry) => entry.unmatched).map((entry) => entry.sourceKey),
      unmatchedRolloutKeys: entries.filter((entry) => entry.unmatchedRollout).map((entry) => entry.sourceKey),
    },
    nativeChildren: entries.flatMap((entry) => entry.children),
  }
}

function externalMessageID(runtimeScope: string, threadID: string, turnID: string, canonicalItemID: string) {
  return SessionMessage.ID.make(
    `msg_codex_${[runtimeScope, threadID, turnID, canonicalItemID].map(encodeURIComponent).join("_")}`,
  )
}

function externalOrderKey(runtimeScope: string, threadID: string, turnID: string, canonicalItemID: string) {
  return `codex_order_${[runtimeScope, threadID, turnID, canonicalItemID].map(encodeURIComponent).join("_")}`
}

function tokens(usage: CodexThreadSnapshot["usage"]): ViewAvailability<ViewTokens> {
  if (usage.status !== "available") return usage
  return tokensFromValue(usage.value)
}

function tokensFromValue(value: BrowserValue): ViewAvailability<ViewTokens> {
  const root = record(value)
  const total = record(root.total ?? record(root.info).total_token_usage ?? root)
  const input = number(total.inputTokens ?? total.input_tokens)
  const output = number(total.outputTokens ?? total.output_tokens)
  const reasoning = number(total.reasoningOutputTokens ?? total.reasoning_output_tokens)
  const read = number(total.cachedInputTokens ?? total.cached_input_tokens)
  const write = number(total.cacheWriteInputTokens ?? total.cache_write_input_tokens)
  if (
    input === undefined ||
    output === undefined ||
    reasoning === undefined ||
    read === undefined ||
    write === undefined
  ) {
    return { status: "unavailable" }
  }
  return {
    status: "available",
    value: {
      ...(number(total.totalTokens ?? total.total_tokens) === undefined
        ? {}
        : { total: number(total.totalTokens ?? total.total_tokens) }),
      input,
      output,
      reasoning,
      cache: { read, write },
    },
  }
}

function contextWindow(usage: CodexThreadSnapshot["usage"]): ViewAvailability<number> {
  if (usage.status !== "available") return usage
  const value = number(record(usage.value).modelContextWindow)
  return value === undefined ? { status: "unavailable" } : { status: "available", value }
}

function contextTokens(usage: CodexThreadSnapshot["usage"]): ViewAvailability<number> {
  if (usage.status !== "available") return usage
  return contextTokensFromValue(usage.value)
}

function contextTokensFromValue(value: BrowserValue): ViewAvailability<number> {
  const root = record(value)
  const last = record(root.last ?? record(root.info).last_token_usage)
  const total = number(last.totalTokens ?? last.total_tokens)
  return total === undefined ? { status: "unavailable" } : { status: "available", value: total }
}

function diffAvailability(diff: ProjectionAvailability<string>): ViewAvailability<FileDiff.Info[]> {
  if (diff.status !== "available") return diff
  return { status: "available", value: unifiedDiffs(diff.value) }
}

export function unifiedDiffs(diff: string): FileDiff.Info[] {
  if (!diff) return []
  const starts = [...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
  if (!starts.length) return [{ patch: diff, additions: additions(diff), deletions: deletions(diff) }]
  return starts.map((match, index) => {
    const patch = diff.slice(match.index, starts[index + 1]?.index ?? diff.length)
    const oldFile = match[1]
    const newFile = match[2]
    return {
      file: newFile === "/dev/null" ? oldFile : newFile,
      patch,
      additions: additions(patch),
      deletions: deletions(patch),
      status: patch.includes("new file mode") ? "added" : patch.includes("deleted file mode") ? "deleted" : "modified",
    }
  })
}

function additions(diff: string) {
  return diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length
}

function deletions(diff: string) {
  return diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length
}

function epochTime(timestamp: string) {
  const created = Date.parse(timestamp)
  return Number.isFinite(created) ? { created } : {}
}

function latest<Value>(values: Value[]) {
  return values.at(-1)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  return JSON.stringify(value)
}

function string(value: unknown) {
  return typeof value === "string" ? value : ""
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function textValues(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === "string") return [item]
    if (!record(item).text || typeof record(item).text !== "string") return []
    return [record(item).text as string]
  })
}
