import type { LabDescribeOutput, OpenCodeEvent } from "@opencode-ai/lab-client"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { AssistantMessage, FilePart, Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { Option, Schema } from "effect"

const placeholderAgent = "codex"
const placeholderModel = { id: "unknown", providerID: "codex" }
const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const decodeToolInput = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export type ExternalMessageAvailability = {
  time: boolean
  agent: boolean
  model: boolean
  cost?: boolean
  tokens?: boolean
}

export type ExternalProjectedMessage = Message & {
  orderKey: string
  externalOrderTie: number
  externalAvailability: ExternalMessageAvailability
  externalStreaming?: boolean
}

export type ExternalMessageProjection = {
  messages: ExternalProjectedMessage[]
  parts: Map<string, Part[]>
  availability: Record<string, ExternalMessageAvailability>
  timeline: SessionMessageInfo[]
}

type ExternalChangedEvent = Extract<OpenCodeEvent, { type: "session.external.changed" }>
export type ExternalWireMessage = NonNullable<ExternalChangedEvent["data"]["messages"]>[number]
type ExternalAssistantMessage = Extract<ExternalWireMessage, { type: "assistant" }>
type ExternalToolContent = Extract<ExternalAssistantMessage["content"][number], { type: "tool" }>
type ExternalToolPart = ToolPart & { externalStatus?: "unknown"; externalOutput?: string }
export type ExternalVersion = Pick<LabDescribeOutput[number], "epoch" | "revision">
export type ExternalVersionDecision = "initial" | "next" | "duplicate" | "gap" | "epoch"

export function compareExternalVersion(
  current: ExternalVersion | undefined,
  incoming: ExternalVersion,
): ExternalVersionDecision {
  if (!current) return "initial"
  if (current.epoch !== incoming.epoch) return "epoch"
  if (incoming.revision <= current.revision) return "duplicate"
  if (incoming.revision === current.revision + 1) return "next"
  return "gap"
}

export function projectExternalMessages(input: {
  sessionID: string
  messages: readonly ExternalWireMessage[]
  messageOrder?: readonly string[]
  partOrder?: Readonly<Record<string, readonly string[]>>
}): ExternalMessageProjection {
  const order = new Map(input.messageOrder?.map((id, index) => [id, index]))
  const source = input.messages.slice().sort((a, b) => {
    const left = order.get(a.id)
    const right = order.get(b.id)
    if (left !== undefined || right !== undefined)
      return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER)
    return a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const messages: ExternalProjectedMessage[] = []
  const parts = new Map<string, Part[]>()
  const availability: Record<string, ExternalMessageAvailability> = {}
  let parent: (ExternalProjectedMessage & UserMessage) | undefined

  source.forEach((message, index) => {
    const orderKey = index.toString().padStart(16, "0")
    if (message.type === "user" || message.type === "system") {
      const info = userMessage(input.sessionID, message, index, orderKey)
      messages.push(info)
      parts.set(
        info.id,
        sortParts(
          message.type === "user"
            ? userParts(input.sessionID, message)
            : [textPart(input.sessionID, message.id, `${message.id}:text`, message.text, true)],
          input.partOrder?.[message.id],
        ),
      )
      availability[info.id] = info.externalAvailability
      parent = info
      return
    }

    const currentParent = parent ?? orphanParent(input.sessionID, message, index, orderKey)
    if (!parent) {
      parent = currentParent
      messages.push(currentParent)
      parts.set(currentParent.id, [])
      availability[currentParent.id] = currentParent.externalAvailability
    }

    const info = assistantMessage(input.sessionID, currentParent.id, message, index, orderKey)
    const projectedParts = assistantParts(input.sessionID, message, index)
    messages.push(info)
    parts.set(info.id, sortParts(projectedParts, input.partOrder?.[message.id]))
    availability[info.id] = info.externalAvailability
    if (message.agent) currentParent.agent = message.agent
    if (message.model)
      currentParent.model = {
        providerID: message.model.providerID,
        modelID: message.model.id,
        variant: message.model.variant,
      }
  })

  return { messages, parts, availability, timeline: messages.map(timelineMessage) }
}

function timelineMessage(message: ExternalProjectedMessage): SessionMessageInfo {
  if (message.role === "user") {
    return {
      id: message.id,
      type: "user",
      time: message.time,
      text: "",
    }
  }
  return {
    id: message.id,
    type: "assistant",
    time: message.time,
    agent: message.agent,
    model: { id: message.modelID, providerID: message.providerID, variant: message.variant },
    content: [],
  }
}

function userMessage(
  sessionID: string,
  message: Extract<ExternalWireMessage, { type: "user" | "system" }>,
  index: number,
  orderKey: string,
): ExternalProjectedMessage & UserMessage {
  return {
    id: message.id,
    sessionID,
    role: "user",
    time: { created: message.time.created ?? placeholderTime(index) },
    agent: placeholderAgent,
    model: { providerID: placeholderModel.providerID, modelID: placeholderModel.id },
    orderKey,
    externalOrderTie: 1,
    externalAvailability: { time: message.time.created !== undefined, agent: false, model: false },
  }
}

function orphanParent(
  sessionID: string,
  message: ExternalAssistantMessage,
  index: number,
  orderKey: string,
): ExternalProjectedMessage & UserMessage {
  return {
    id: `${message.id}:parent`,
    sessionID,
    role: "user",
    time: { created: message.time.created ?? placeholderTime(index) },
    agent: message.agent ?? placeholderAgent,
    model: {
      providerID: message.model?.providerID ?? placeholderModel.providerID,
      modelID: message.model?.id ?? placeholderModel.id,
      variant: message.model?.variant,
    },
    orderKey,
    externalOrderTie: 0,
    externalAvailability: {
      time: message.time.created !== undefined,
      agent: message.agent !== undefined,
      model: message.model !== undefined,
    },
  }
}

function assistantMessage(
  sessionID: string,
  parentID: string,
  message: ExternalAssistantMessage,
  index: number,
  orderKey: string,
): ExternalProjectedMessage & AssistantMessage {
  const error = message.error
    ? message.error.message.toLowerCase().includes("abort") || message.error.message.toLowerCase().includes("interrupt")
      ? { name: "MessageAbortedError" as const, data: { message: message.error.message } }
      : { name: "UnknownError" as const, data: { message: message.error.message } }
    : undefined
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: {
      created: message.time.created ?? placeholderTime(index),
      completed: message.time.completed,
    },
    error,
    parentID,
    modelID: message.model?.id ?? placeholderModel.id,
    providerID: message.model?.providerID ?? placeholderModel.providerID,
    variant: message.model?.variant,
    mode: message.agent ?? placeholderAgent,
    agent: message.agent ?? placeholderAgent,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? emptyTokens,
    finish: message.finish,
    externalStreaming: message.streaming,
    orderKey,
    externalOrderTie: 1,
    externalAvailability: {
      time: message.time.created !== undefined,
      agent: message.agent !== undefined,
      model: message.model !== undefined,
      cost: message.cost !== undefined,
      tokens: message.tokens !== undefined,
    },
  }
}

function userParts(sessionID: string, message: Extract<ExternalWireMessage, { type: "user" }>): Part[] {
  return [
    textPart(sessionID, message.id, `${message.id}:text`, message.text),
    ...(message.files ?? []).map((file, index) => filePart(sessionID, message.id, `${message.id}:file:${index}`, file)),
    ...(message.agents ?? []).map(
      (agent, index): Part => ({
        id: `${message.id}:agent:${index}`,
        sessionID,
        messageID: message.id,
        type: "agent",
        name: agent.name,
        source: agent.source
          ? { value: agent.source.text, start: agent.source.start, end: agent.source.end }
          : undefined,
      }),
    ),
  ]
}

function assistantParts(sessionID: string, message: ExternalAssistantMessage, index: number): Part[] {
  return message.content.flatMap((content): Part[] => {
    if (content.type === "text")
      return content.text.trim() ? [textPart(sessionID, message.id, content.id, content.text)] : []
    if (content.type === "reasoning") {
      if (!content.text.trim()) return []
      return [
        {
          id: content.id,
          sessionID,
          messageID: message.id,
          type: "reasoning",
          text: content.text,
          metadata: content.providerMetadata,
          time: {
            start: content.time?.created ?? message.time.created ?? placeholderTime(index),
            end: content.time?.completed,
          },
        },
      ]
    }
    return [toolPart(sessionID, message.id, content, message.time.created ?? placeholderTime(index))]
  })
}

function toolPart(
  sessionID: string,
  messageID: string,
  tool: ExternalToolContent,
  fallbackTime: number,
): ExternalToolPart {
  const start = tool.time.ran ?? tool.time.created ?? fallbackTime
  const provider = tool.provider
  const metadata = {
    ...(tool.state.status === "pending" || tool.state.status === "unknown" ? {} : tool.state.structured),
    externalContent:
      tool.state.status === "pending" || tool.state.status === "unknown" ? undefined : tool.state.content,
    externalProvider: provider,
    externalResult: tool.state.status === "completed" || tool.state.status === "error" ? tool.state.result : undefined,
    externalOutputPaths: tool.state.status === "completed" ? tool.state.outputPaths : undefined,
    externalNativeStatus: tool.state.status === "unknown" ? tool.state.nativeStatus : undefined,
  }
  const state: ToolPart["state"] = (() => {
    if (tool.state.status === "pending" || tool.state.status === "unknown") {
      const decoded = Option.getOrUndefined(decodeToolInput(tool.state.input))
      return { status: "pending", input: record(decoded), raw: tool.state.input }
    }
    if (tool.state.status === "running")
      return { status: "running", input: tool.state.input, metadata, time: { start } }
    if (tool.state.status === "error") {
      return {
        status: "error",
        input: tool.state.input,
        error: tool.state.error.message,
        metadata,
        time: { start, end: tool.time.completed ?? start },
      }
    }
    const attachments = [
      ...(tool.state.attachments ?? []).map((file, index) =>
        filePart(sessionID, messageID, `${tool.id}:attachment:${index}`, file),
      ),
      ...tool.state.content.flatMap((content, index) =>
        content.type === "file" ? [filePart(sessionID, messageID, `${tool.id}:content:${index}`, content)] : [],
      ),
    ]
    return {
      status: "completed",
      input: tool.state.input,
      output: tool.state.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n"),
      title: tool.name,
      metadata,
      time: { start, end: tool.time.completed ?? start },
      attachments: attachments.length ? attachments : undefined,
    }
  })()
  return {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state,
    metadata: { externalProvider: provider },
    externalStatus: tool.state.status === "unknown" ? "unknown" : undefined,
    externalOutput: tool.state.status === "unknown" ? tool.state.output : undefined,
  }
}

function filePart(
  sessionID: string,
  messageID: string,
  id: string,
  file: { uri: string; mime: string; name?: string; source?: { text: string; start: number; end: number } },
): FilePart {
  return {
    id,
    sessionID,
    messageID,
    type: "file",
    mime: file.mime,
    filename: file.name,
    url: file.uri,
    source: file.source
      ? {
          type: "file",
          text: { value: file.source.text, start: file.source.start, end: file.source.end },
          path: file.name ?? file.source.text,
        }
      : undefined,
  }
}

function textPart(sessionID: string, messageID: string, id: string, text: string, synthetic?: boolean): Part {
  return { id, sessionID, messageID, type: "text", text, synthetic }
}

function sortParts(parts: Part[], order: readonly string[] | undefined) {
  if (!order) return parts
  const index = new Map(order.map((id, position) => [id, position]))
  return parts.slice().sort((a, b) => {
    const left = index.get(a.id)
    const right = index.get(b.id)
    if (left !== undefined || right !== undefined)
      return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER)
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

function placeholderTime(index: number) {
  return index
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
