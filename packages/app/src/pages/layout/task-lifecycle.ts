import type { Session } from "@opencode-ai/sdk/v2/client"
import type { ServerCtx } from "@/context/global"
import type { ServerConnection } from "@/context/server"
import type { useTabs } from "@/context/tabs"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { normalizeSessionInfo } from "@/utils/session"

export type TaskLifecycleOperation = "archive" | "restore" | "delete"

export async function mutateTask(input: {
  context: ServerCtx
  tabs: ReturnType<typeof useTabs>
  server: ServerConnection.Key
  projectDirectory: string
  session?: Session
  sessionID?: string
  operation: TaskLifecycleOperation
  onArchivedOrDeleted: () => void
}) {
  const sessionID = input.session?.id ?? input.sessionID
  if (!sessionID) throw new Error("Task lifecycle mutation requires a session ID")
  const session =
    input.session ??
    normalizeSessionInfo(await input.context.sdk.api.session.get({ sessionID, directory: input.projectDirectory }))
  const target = { type: "session" as const, server: input.server, sessionId: sessionID }

  if (input.operation === "archive") {
    await input.context.sdk.api.session.archive({ sessionID, directory: input.projectDirectory })
  }
  if (input.operation === "restore") {
    await input.context.sdk.api.session.restore({ sessionID, directory: input.projectDirectory })
  }
  if (input.operation === "delete") {
    await input.context.sdk.api.session.remove({ sessionID, directory: input.projectDirectory })
  }

  const info =
    input.operation === "archive"
      ? { ...session, time: { ...session.time, archived: Date.now() } }
      : input.operation === "restore"
        ? { ...session, time: { ...session.time, archived: undefined } }
        : session
  input.context.sync.homeSessions.apply({
    type: input.operation === "delete" ? "session.deleted" : "session.updated",
    properties: { sessionID, info },
  })
  void input.context.queryClient.invalidateQueries({ queryKey: ["task-search", input.context.sdk.scope] })

  if (input.operation !== "delete") input.tabs.rememberSessionInfo(target, info)
  if (input.operation === "restore") input.context.projects.open(input.projectDirectory)
  if (input.operation === "restore") return info

  const [, setChild] = input.context.sync.child(session.directory, { bootstrap: false })
  setChild("session", (sessions) => sessions.filter((item) => item.id !== sessionID))
  if (input.operation === "delete" && input.context.tasks.pinned().includes(sessionID)) {
    input.context.tasks.togglePin(sessionID)
  }
  notifySessionTabsRemoved({ server: input.server, directory: session.directory, sessionIDs: [sessionID] })
  input.onArchivedOrDeleted()
  return info
}
