import type { AssistantMessage, ToolPart } from "@opencode-ai/sdk/v2"
import { DataProvider } from "@opencode-ai/session-ui/context/data"
import { ContextToolGroup, Message } from "@opencode-ai/session-ui/message-part"
import { render } from "solid-js/web"

export function tool(input: {
  name: string
  status: "pending" | "running" | "completed" | "error"
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  args?: Record<string, unknown>
}) {
  return {
    id: `part-${input.name}`,
    type: "tool",
    tool: input.name,
    sessionID: "session-parent",
    messageID: "message-assistant",
    callID: `call-${input.name}`,
    state: {
      status: input.status,
      input: input.args ?? {},
      output: input.output,
      error: input.error,
      metadata: input.metadata,
    },
  } as unknown as ToolPart
}

export function mount(input: {
  part: ToolPart
  onInspectTool?: (part: ToolPart) => void
  onPreviewSession?: (id: string) => void
}) {
  const root = document.createElement("div")
  document.body.append(root)
  const message = {
    id: "message-assistant",
    sessionID: "session-parent",
    role: "assistant",
    parentID: "message-user",
    time: { created: 1 },
  } as AssistantMessage

  const dispose = render(
    () => (
      <DataProvider
        data={{
          agent: [{ name: "explore", color: "blue" }],
          session: [],
          session_status: {},
          session_diff: {},
          message: {},
          part: {},
        }}
        directory="/project"
        sessionID="session-parent"
        onSessionHref={(id) => `/session/${id}`}
      >
        <Message
          message={message}
          parts={[input.part]}
          onInspectTool={input.onInspectTool}
          onPreviewSession={input.onPreviewSession}
        />
      </DataProvider>
    ),
    root,
  )
  return { root, dispose }
}

export function mountContext(parts: ToolPart[], onInspectTool: (part: ToolPart) => void) {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <DataProvider
        data={{ session: [], session_status: {}, session_diff: {}, message: {}, part: {} }}
        directory="/project"
      >
        <ContextToolGroup parts={parts} onInspectTool={onInspectTool} />
      </DataProvider>
    ),
    root,
  )
  return { root, dispose }
}

export function click(target: Element, init?: MouseEventInit) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
  target.dispatchEvent(event)
  return event
}
