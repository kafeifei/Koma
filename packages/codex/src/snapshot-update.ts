import type { SessionExternal } from "@opencode-ai/schema/session-external"

type Change = typeof SessionExternal.Changed.data.Type

export function toolOutputAppend(
  before: SessionExternal.Message,
  after: SessionExternal.Message,
): Change["toolAppend"] {
  if (before.type !== "assistant" || after.type !== "assistant" || before.content.length !== after.content.length)
    return
  const changed = after.content.flatMap((part, index) => (equal(before.content[index], part) ? [] : [index]))
  if (changed.length !== 1) return
  const index = changed[0]
  const left = before.content[index],
    right = after.content[index]
  if (
    left.type !== "tool" ||
    right.type !== "tool" ||
    left.id !== right.id ||
    left.state.status !== "running" ||
    right.state.status !== "running"
  )
    return
  const output = (part: typeof left) => {
    if (part.state.status !== "running") return
    if (!part.state.content.length) return ""
    if (part.state.content.length !== 1 || part.state.content[0].type !== "text") return
    return part.state.content[0].text
  }
  const oldText = output(left),
    newText = output(right)
  if (oldText === undefined || newText === undefined || !newText.startsWith(oldText) || newText === oldText) return
  const normalize = (part: typeof left) => {
    if (part.state.status !== "running") return part
    const { output: _, ...structured } = part.state.structured
    return { ...part, state: { ...part.state, content: [], structured } }
  }
  const metadata = (message: SessionExternal.Message) => {
    const meta = message.metadata
    const codex = meta?.codex
    if (!codex || typeof codex !== "object" || Array.isArray(codex)) return meta
    const raw = (codex as Record<string, unknown>).raw
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      (raw as Record<string, unknown>).type !== "commandExecution"
    )
      return meta
    return { ...meta, codex: { ...codex, raw: { ...raw, aggregatedOutput: "" } } }
  }
  if (
    !equal(
      {
        ...before,
        metadata: metadata(before),
        content: before.content.map((part, i) => (i === index ? normalize(left) : part)),
      },
      {
        ...after,
        metadata: metadata(after),
        content: after.content.map((part, i) => (i === index ? normalize(right) : part)),
      },
    )
  )
    return
  if (right.state.structured.output !== newText || (left.state.structured.output ?? "") !== oldText) return
  return { messageID: after.id, partID: right.id, offset: oldText.length, delta: newText.slice(oldText.length) }
}

export function snapshotUpdate(
  before: SessionExternal.Snapshot,
  after: SessionExternal.Snapshot,
): Pick<Change, "update" | "messages"> {
  const previous = new Map(before.messages.map((message) => [message.id, message]))
  const messages = after.messages.filter((message) => !equal(previous.get(message.id), message))
  const update: Record<string, unknown> = { baseRevision: before.descriptor.revision }
  // Most native items append to the timeline. Do not resend all previous IDs
  // or the entire part index every time a tool starts or finishes.
  if (
    before.messageOrder.length > after.messageOrder.length ||
    before.messageOrder.some((id, index) => after.messageOrder[index] !== id)
  ) {
    update.messageOrder = after.messageOrder
  }
  const partOrder = Object.fromEntries(
    Object.entries(after.partOrder).filter(([id, parts]) => !equal(before.partOrder[id], parts)),
  )
  if (Object.keys(partOrder).length) update.partOrder = partOrder
  const keys = [
    "interactions",
    "deliveries",
    "usage",
    "contextWindow",
    "contextTokens",
    "cost",
    "turnDiffs",
    "sessionDiff",
    "plan",
    "children",
  ] as const
  for (const key of keys) {
    if (!equal(before[key], after[key])) update[key] = after[key] ?? { status: "unavailable" }
  }
  return {
    update: update as NonNullable<Change["update"]>,
    ...(messages.length ? { messages } : {}),
  }
}

function equal(left: unknown, right: unknown) {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}
