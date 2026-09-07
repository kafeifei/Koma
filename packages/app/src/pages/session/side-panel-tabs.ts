import type { ToolPart } from "@opencode-ai/sdk/v2"

import type { SessionTabs } from "@/context/layout-tabs"

export const REVIEW_TAB = "review://"

export type SidePanelTab =
  | { type: "review" }
  | { type: "terminal"; id: string }
  | { type: "session"; sessionID: string }
  | { type: "tool"; sessionID: string; messageID: string; partID: string }

export const terminalTab = (id: string) => `terminal://${id}`
export const childSessionTab = (sessionID: string) => `session://${sessionID}`
export const toolDetailTab = (part: Pick<ToolPart, "sessionID" | "messageID" | "id">) =>
  `tool://${part.sessionID}/${part.messageID}/${part.id}`

export function sidePanelTab(tab: string | undefined): SidePanelTab | undefined {
  if (tab === REVIEW_TAB) return { type: "review" }
  if (tab?.startsWith("terminal://") && tab.length > 11) return { type: "terminal", id: tab.slice(11) }
  if (tab?.startsWith("session://") && tab.length > 10) return { type: "session", sessionID: tab.slice(10) }
  if (!tab?.startsWith("tool://")) return undefined
  const [sessionID, messageID, partID, extra] = tab.slice(7).split("/")
  if (!sessionID || !messageID || !partID || extra !== undefined) return undefined
  return { type: "tool", sessionID, messageID, partID }
}

// Upgrade only UI tab identities. The sessions, tool history and PTYs remain owned
// by their existing stores; a closed Review tab is never added as a default.
export function normalizeWorkspaceTabs(current: SessionTabs): SessionTabs {
  const legacy =
    current.active === "review" ||
    current.active === "background-tasks" ||
    current.all.some((tab) => tab === "review" || tab === "background-tasks")
  if (!legacy) return current

  const all = [
    ...new Set(
      current.all.filter((tab) => tab !== "background-tasks").map((tab) => (tab === "review" ? REVIEW_TAB : tab)),
    ),
  ]
  const active =
    current.active === "review" ? REVIEW_TAB : current.active === "background-tasks" ? undefined : current.active
  if (active === REVIEW_TAB && !all.includes(active)) all.push(active)
  return { all, active: active ?? all[0] }
}
