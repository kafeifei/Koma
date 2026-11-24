import { useQueryClient } from "@tanstack/solid-query"
import type { SessionInfo } from "@opencode/client/promise"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { notifySessionTabsRemoved } from "./session-events"

/**
 * Koma: archives a session from the project sidebar. The session leaves every list and its tab closes; Archived at
 * the foot of the sidebar brings it back.
 */
export function createSessionArchiver() {
  const global = useGlobal()
  const language = useLanguage()
  const queryClient = useQueryClient()

  return (server: string, session: Pick<SessionInfo, "id" | "location">) => {
    const conn = global.servers.list().find((entry) => ServerConnection.key(entry) === server)
    const ctx = conn ? global.serverCtx(ServerConnection.key(conn)) : undefined

    if (!conn || !ctx) return

    void ctx.sdk.api.session
      .update({ sessionID: session.id, archived: true })
      .then(() => {
        for (const queryKey of ["home-sessions", "inbox-sessions", "inbox-archived-sessions"]) {
          void queryClient.invalidateQueries({ queryKey: [queryKey, conn], exact: true })
        }

        notifySessionTabsRemoved({
          server: ServerConnection.Key.make(server),
          directory: session.location.directory,
          sessionIDs: [session.id],
        })
      })
      .catch((cause) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(cause, language.t("common.requestFailed")),
        }),
      )
  }
}
