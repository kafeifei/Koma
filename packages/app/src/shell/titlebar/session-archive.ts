import { useQueryClient } from "@tanstack/solid-query"
import type { SessionInfo } from "@opencode/client/promise"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { sessionLabel } from "@/session/title"
import { notifySessionTabsRemoved } from "./session-events"

/**
 * Koma: archives a session from the project sidebar. The session leaves every list and its tab closes; the toast's
 * Undo, or Archived at the foot of the sidebar, brings it back.
 */
export function createSessionArchiver() {
  const global = useGlobal()
  const language = useLanguage()
  const queryClient = useQueryClient()

  return (server: string, session: Pick<SessionInfo, "id" | "location" | "title">) => {
    const conn = global.servers.list().find((entry) => ServerConnection.key(entry) === server)
    const ctx = conn ? global.serverCtx(ServerConnection.key(conn)) : undefined

    if (!conn || !ctx) return

    const refresh = () => {
      for (const queryKey of ["home-sessions", "inbox-sessions", "inbox-archived-sessions"]) {
        void queryClient.invalidateQueries({ queryKey: [queryKey, conn], exact: true })
      }
    }

    const failed = (cause: unknown) =>
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      })

    const undo = () =>
      void ctx.sdk.api.session.update({ sessionID: session.id, archived: false }).then(refresh).catch(failed)

    void ctx.sdk.api.session
      .update({ sessionID: session.id, archived: true })
      .then(() => {
        refresh()
        notifySessionTabsRemoved({
          server: ServerConnection.Key.make(server),
          directory: session.location.directory,
          sessionIDs: [session.id],
        })
        // The toast closes itself once an action runs.
        showToast({
          title: language.t("sidebar.session.archived", { title: sessionLabel(session) }),
          actions: [{ label: language.t("sidebar.session.archived.undo"), onClick: undo }],
        })
      })
      .catch(failed)
  }
}
