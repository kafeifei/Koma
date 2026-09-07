import type { Message, Part, Session, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"

export type InspectorTool = {
  messageID: string
  part: ToolPart
}

export async function discoverChildSessions(input: {
  rootID: string
  protocol: Promise<"v1" | "v2">
  signal: AbortSignal
  children: (sessionID: string, signal: AbortSignal) => Promise<Session[]>
  list: (cursor: string | undefined, signal: AbortSignal) => Promise<{ data: Session[]; cursor?: string }>
}) {
  if ((await input.protocol) === "v1") {
    const found: Session[] = []
    const visited = new Set([input.rootID])
    const pending = [input.rootID]
    while (pending.length > 0) {
      input.signal.throwIfAborted()
      const parentID = pending.shift()!
      const children = await input.children(parentID, input.signal)
      children.forEach((session) => {
        if (visited.has(session.id)) return
        visited.add(session.id)
        found.push(session)
        pending.push(session.id)
      })
    }
    return found
  }

  const sessions: Session[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    input.signal.throwIfAborted()
    const page = await input.list(cursor, input.signal)
    sessions.push(...page.data)
    cursor = page.cursor
    if (!cursor || cursors.has(cursor)) break
    cursors.add(cursor)
  } while (cursor)

  const indexed = Object.fromEntries(sessions.map((session) => [session.id, session]))
  return relatedChildSessions(input.rootID, indexed, [])
}

export function inspectorTools(messages: readonly Message[], parts: Record<string, Part[] | undefined>) {
  return messages.flatMap((message) =>
    (parts[message.id] ?? [])
      .filter((part): part is ToolPart => part.type === "tool" && part.tool !== "todowrite")
      .map((part) => ({ messageID: message.id, part })),
  )
}

export function taskSessionID(part: ToolPart): string | undefined {
  if (part.tool !== "task" && part.tool !== "codex.subagent") return undefined
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (typeof metadata?.sessionId === "string" && metadata.sessionId) return metadata.sessionId
  if (!("input" in part.state) || !record(part.state.input) || part.state.input.nativeSubagent !== true)
    return undefined
  if (typeof part.state.input.sessionId === "string" && part.state.input.sessionId) return part.state.input.sessionId
  return undefined
}

export function relatedChildSessions(
  rootID: string,
  sessions: Record<string, Session | undefined>,
  tools: readonly InspectorTool[],
) {
  const referenced = new Set(tools.flatMap((item) => taskSessionID(item.part) ?? []))
  const related = (session: Session) => {
    const seen = new Set<string>()
    let parentID = session.parentID
    while (parentID && !seen.has(parentID)) {
      if (parentID === rootID) return true
      seen.add(parentID)
      parentID = sessions[parentID]?.parentID
    }
    return referenced.has(session.id)
  }

  return Object.values(sessions)
    .filter((session): session is Session => !!session && session.id !== rootID && related(session))
    .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
}

export function visibleMessage(message: Message, parts: readonly Part[]) {
  if (message.role === "user")
    return parts.some(
      (part) =>
        (part.type === "text" && !part.synthetic && !!part.text.trim()) ||
        part.type === "file" ||
        part.type === "agent",
    )

  return parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") return !!part.text.trim()
    if (part.type !== "tool") return false
    if (part.tool === "todowrite") return false
    if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"
    return true
  })
}

export function toolStatus(part: ToolPart) {
  if (part.state.status === "pending" || part.state.status === "running") return "running" as const
  return part.state.status
}

export function sessionStatus(status: SessionStatus | undefined) {
  if (!status) return "unknown" as const
  if (status.type === "idle") return "idle" as const
  if (status.type === "retry") return "retry" as const
  return "running" as const
}

export function childSessionStatus(session: Session, status: SessionStatus | undefined) {
  if (session.time.archived) return "archived" as const
  return sessionStatus(status)
}

const richToolDetails = new Set([
  "list",
  "glob",
  "grep",
  "bash",
  "shell",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "websearch",
  "question",
])
const fallbackToolDetails = new Set(["read", "webfetch", "skill", "task", "todowrite"])

export function rawToolDetail(
  part: ToolPart,
  registered = false,
): { type: "input" | "output"; text: string } | undefined {
  if (richToolDetails.has(part.tool)) return undefined
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  const native = part.tool.startsWith("codex.") || metadata?.nativeSubagent === true
  const nativeFallback =
    native &&
    (part.state.status === "pending" ||
      (part.state.status === "error" && typeof metadata?.output === "string" && !!metadata.output.trim()))
  if (registered && !fallbackToolDetails.has(part.tool) && !nativeFallback) return undefined
  if (typeof metadata?.output === "string" && metadata.output.trim()) return { type: "output", text: metadata.output }
  if (part.state.status === "completed" && part.state.output)
    return { type: "output" as const, text: part.state.output }
  if (part.state.status === "error") return undefined
  if (part.state.status === "pending" && part.state.raw.trim()) return { type: "input", text: part.state.raw }
  const value = Object.keys(metadata ?? {}).length > 0 ? { input: part.state.input, metadata } : part.state.input
  if (Object.keys(value).length > 0) return { type: "input", text: JSON.stringify(value, null, 2) }
  return undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
