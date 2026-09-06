import type { Message, ToolPart } from "@opencode-ai/sdk/v2"

type Field = "time" | "agent" | "model" | "cost" | "tokens"
type DisplayMessage = Message & {
  externalAvailability?: Partial<Record<Field, boolean>>
  externalStreaming?: boolean
}

// Some native read models cannot supply fields required by the legacy SDK.
// Their compatibility placeholders must never become visible facts.
export function messageFieldAvailable(message: DisplayMessage | undefined, field: Field) {
  return message?.externalAvailability?.[field] !== false
}

export function isMessageStreaming(message: DisplayMessage) {
  if (message.role !== "assistant") return false
  return message.externalStreaming ?? typeof message.time.completed !== "number"
}

export function toolDisplayState(part: ToolPart & { externalStatus?: string; externalOutput?: string }) {
  return {
    status: part.externalStatus ?? part.state.status,
    output: part.externalOutput ?? ("output" in part.state ? part.state.output : undefined),
  }
}
