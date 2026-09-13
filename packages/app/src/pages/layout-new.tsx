import { createEffect, Show, Suspense, type ParentProps } from "solid-js"
import { useStartupTask } from "@/desktop/startup"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { createElementSize } from "@solid-primitives/resize-observer"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { TaskSidebar } from "./layout/task-sidebar"
import { debugToolsEnabled } from "@/utils/debug-tools"
import { WORKSPACE_PANEL_MIN_WIDTH } from "./layout/layout-width"
import { REVIEW_PANE_WIDTH_MIN, SESSION_PANEL_WIDTH_MIN } from "./session/session-panel-width"
import { InitialTaskRoute } from "./layout/initial-task-route"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const language = useLanguage()
  const mobile = createMediaQuery("(max-width: 900px)")
  let body: HTMLDivElement | undefined
  const bodySize = createElementSize(() => body)
  const [state, setState] = createStore({ debugTools: false, mobileSidebar: false })
  const [sidebar, setSidebar, , sidebarReady] = persisted(
    Persist.window("workspace.sidebar"),
    createStore({ opened: true, width: WORKSPACE_PANEL_MIN_WIDTH }),
  )
  useStartupTask("workspace", () => ({ ready: sidebarReady() }))
  const maxWidth = () =>
    Math.max(
      WORKSPACE_PANEL_MIN_WIDTH,
      Math.min(480, (bodySize.width ?? 0) - SESSION_PANEL_WIDTH_MIN - REVIEW_PANE_WIDTH_MIN),
    )
  const sidebarWidth = () => Math.max(WORKSPACE_PANEL_MIN_WIDTH, Math.min(sidebar.width, maxWidth()))
  const opened = () => (mobile() ? state.mobileSidebar : sidebar.opened)
  const toggle = () =>
    mobile() ? setState("mobileSidebar", (value) => !value) : setSidebar("opened", (value) => !value)

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      data-component="task-workspace"
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
        "--workspace-sidebar-width": `${sidebarWidth()}px`,
      }}
    >
      <InitialTaskRoute />
      <Titlebar
        update={update}
        workspace={{ opened: opened(), docked: !mobile() && opened(), toggle }}
        debugTools={
          debugToolsEnabled(platform)
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <div
        ref={body}
        data-slot="workspace-body"
        onKeyDown={(event) => {
          if (event.key === "Escape" && mobile()) setState("mobileSidebar", false)
        }}
      >
        <TaskSidebar opened={opened()} onNavigate={() => setState("mobileSidebar", false)}>
          <Show when={!mobile() && opened()}>
            <ResizeHandle
              direction="horizontal"
              size={sidebarWidth()}
              min={WORKSPACE_PANEL_MIN_WIDTH}
              max={maxWidth()}
              onResize={(width) => setSidebar("width", width)}
            />
          </Show>
        </TaskSidebar>
        <Show when={mobile() && opened()}>
          <button
            type="button"
            data-slot="workspace-backdrop"
            aria-label={language.t("command.sidebar.toggle")}
            onClick={toggle}
          />
        </Show>
        <main
          inert={mobile() && opened()}
          class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict"
        >
          <Suspense
            fallback={
              <div class="m-auto text-v2-text-text-muted" role="status">
                {language.t("common.loading")}
              </div>
            }
          >
            {props.children}
          </Suspense>
        </main>
      </div>
      {debugToolsEnabled(platform) && state.debugTools && <DebugBar inline />}
      <ToastRegion v2 />
    </div>
  )
}
