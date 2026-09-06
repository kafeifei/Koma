import type { SessionTab, Tab } from "./tabs"

export type ClosedTab = {
  tab: SessionTab
  index: number
}

const CLOSED_TAB_LIMIT = 25

// New-task inputs are reopened by directory, not as independently managed tabs.
export function pushClosedTab(stack: ClosedTab[], tab: Tab, index: number): ClosedTab[] {
  if (tab.type !== "session") return stack
  return [...stack, { tab: { ...tab }, index }].slice(-CLOSED_TAB_LIMIT)
}

// Pops the most recently closed tab that is not open again,
// discarding stale entries along the way.
export function takeClosedTab(stack: ClosedTab[], tabs: Tab[]): { entry?: ClosedTab; stack: ClosedTab[] } {
  const remaining = [...stack]
  while (remaining.length) {
    const entry = remaining.pop()
    if (entry && !isOpen(tabs, entry.tab)) return { entry, stack: remaining }
  }
  return { stack: remaining }
}

export function removeClosedTabs(stack: ClosedTab[], server: SessionTab["server"], sessionIDs: string[]) {
  const removed = new Set(sessionIDs)
  return stack.filter((entry) => entry.tab.server !== server || !removed.has(entry.tab.sessionId))
}

export function nextTabAfterClose(tabs: Tab[], index: number, active: boolean) {
  if (!active) return undefined
  return (
    tabs.slice(index + 1).find((tab) => tab.type === "session") ??
    tabs.slice(0, index).findLast((tab) => tab.type === "session") ??
    null
  )
}

function isOpen(tabs: Tab[], tab: SessionTab) {
  return tabs.some((item) => item.type === "session" && item.server === tab.server && item.sessionId === tab.sessionId)
}
