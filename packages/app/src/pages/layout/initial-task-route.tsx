import { createEffect, createSignal } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeSessionQuery } from "@/context/global-sync/home-session-query"
import { useStartupTask } from "@/desktop/startup"

// This belongs to the window lifetime. Returning to Home later must stay on Home.
export function InitialTaskRoute() {
  const location = useLocation()
  const server = useServer()
  const tabs = useTabs()
  const home = createHomeController()
  const sessions = createHomeSessionQuery(home.server.focusedContext)
  const navigate = useNavigate()
  const [pending, setPending] = createSignal(location.pathname === "/")
  useStartupTask("session", () => ({ ready: !pending() || !sessions.loading(), error: sessions.error() }))

  createEffect(() => {
    if (!pending()) return
    if (location.pathname !== "/") {
      setPending(false)
      return
    }
    if (!server.ready() || !tabs.ready() || !home.server.focusedContext()?.sync.project.ready()) return
    if (sessions.loading() || sessions.error()) return
    setPending(false)
    if (sessions.sessions().length === 0) navigate("/new-session", { replace: true })
  })
  return null
}
