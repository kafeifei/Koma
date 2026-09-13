import { useStartupTask } from "@/desktop/startup"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { createHomeController } from "./home/home-controller"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"

export function NewHome() {
  const home = createHomeController()
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  useStartupTask("session", () => ({ ready: !sessions.data.loading(), error: sessions.data.error() }), true)
  useStartupTask("workspace", () => {
    const ctx = home.server.focusedContext()
    const project = home.project.newSession()
    if (!ctx || !ctx.sync.startup.ready) return { ready: false, error: ctx?.sync.startup.error }
    if (!project) return { ready: true }
    const startup = ctx.sync.child(project.worktree)[0].startup
    return { ready: startup?.ready === true, error: startup?.error }
  })
  return (
    <div
      class={`
        m-2 flex min-h-0 flex-1 flex-col self-stretch overflow-hidden rounded-[10px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <ScrollView
        class="min-h-0 flex-1 [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <div
          class={`
            mx-auto flex min-h-full w-full max-w-[760px] flex-col px-5 lg:px-8
          `}
        >
          <HomeSessions sessions={sessions} search={search} scroll={scroll} />
        </div>
      </ScrollView>
    </div>
  )
}
