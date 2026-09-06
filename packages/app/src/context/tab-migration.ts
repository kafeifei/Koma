import type { ServerConnection } from "./server"
import type { PermissionMode, Tab } from "./tabs"

function permissionMode(tab: Record<string, unknown>): PermissionMode | undefined {
  if (tab.permissionMode === "default" || tab.permissionMode === "auto" || tab.permissionMode === "full") {
    return tab.permissionMode
  }
  if (typeof tab.autoAccept === "boolean") return tab.autoAccept ? "auto" : "default"
}

export function migrateTabs(value: unknown, fallback: ServerConnection.Key): Tab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap<Tab>((tab) => {
    if (!tab || typeof tab !== "object") return []
    if ("server" in tab && typeof tab.server !== "string") return []
    const server = ("server" in tab ? tab.server : fallback) as ServerConnection.Key
    if (tab.type === "session" && typeof tab.sessionId === "string") {
      return [{ type: tab.type, server, sessionId: tab.sessionId }]
    }
    if (
      tab.type === "draft" &&
      typeof tab.draftID === "string" &&
      typeof tab.directory === "string" &&
      (tab.worktree === undefined || typeof tab.worktree === "string")
    ) {
      const mode = permissionMode(tab as Record<string, unknown>)
      return [
        {
          type: tab.type,
          server,
          draftID: tab.draftID,
          directory: tab.directory,
          worktree: tab.worktree,
          ...(mode ? { permissionMode: mode } : {}),
        },
      ]
    }
    return []
  })
}
