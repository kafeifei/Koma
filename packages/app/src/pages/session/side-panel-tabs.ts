import type { ToolPart } from "@opencode-ai/sdk/v2"

export const BACKGROUND_TASKS_TAB = "background-tasks"

export type SidePanelTab =
  | { type: "background" }
  | { type: "terminal"; id: string }
  | { type: "session"; sessionID: string }
  | { type: "tool"; sessionID: string; messageID: string; partID: string }

export const terminalTab = (id: string) => `terminal://${id}`
export const childSessionTab = (sessionID: string) => `session://${sessionID}`
export const toolDetailTab = (part: Pick<ToolPart, "sessionID" | "messageID" | "id">) =>
  `tool://${part.sessionID}/${part.messageID}/${part.id}`

export function sidePanelTab(tab: string | undefined): SidePanelTab | undefined {
  if (tab === BACKGROUND_TASKS_TAB) return { type: "background" }
  if (tab?.startsWith("terminal://") && tab.length > 11) return { type: "terminal", id: tab.slice(11) }
  if (tab?.startsWith("session://") && tab.length > 10) return { type: "session", sessionID: tab.slice(10) }
  if (!tab?.startsWith("tool://")) return undefined
  const [sessionID, messageID, partID, extra] = tab.slice(7).split("/")
  if (!sessionID || !messageID || !partID || extra !== undefined) return undefined
  return { type: "tool", sessionID, messageID, partID }
}
