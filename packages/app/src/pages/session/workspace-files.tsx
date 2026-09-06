import { Show, createEffect, createMemo, type JSX } from "solid-js"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { useFile, type SelectedLineRange } from "@/context/file"
import { SESSION_OPEN_FILE_TAB } from "@/context/layout-tabs"
import { setSessionHandoff } from "./handoff"
import { useSessionLayout } from "./session-layout"
import { REVIEW_TAB } from "./side-panel-tabs"
import { useSidePanel } from "./use-side-panel"
import { filterRenderableDiff, reviewDiffKinds } from "./v2/review-diff-kinds"
import { SessionFileBrowserTab, type SessionFileBrowserState } from "./v2/session-file-browser-tab"

export function WorkspaceFiles(props: {
  tab: string | undefined
  diffs: () => (FileDiffInfo | SnapshotFileDiff | VcsFileDiff)[]
  reviewPanel: () => JSX.Element
  state: SessionFileBrowserState
  filterRef: (element: HTMLInputElement) => void
}) {
  const file = useFile()
  const side = useSidePanel()
  const { sessionKey, tabs } = useSessionLayout()
  const kinds = createMemo(() => reviewDiffKinds(props.diffs().filter(filterRenderableDiff)))
  const fileTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab === SESSION_OPEN_FILE_TAB || !!file.pathFromTab(tab)),
  )
  const visible = () => props.tab === SESSION_OPEN_FILE_TAB || !!file.pathFromTab(props.tab ?? "")
  const browserTab = createMemo<string | undefined>((previous) => {
    if (visible()) return props.tab
    if (previous && fileTabs().includes(previous)) return previous
    return fileTabs()[0]
  })

  createEffect(() => {
    if (!file.ready()) return
    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((selected, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return selected
          const lines = file.selectedLines(path)
          selected[path] =
            lines && typeof lines === "object" && "start" in lines && "end" in lines
              ? (lines as SelectedLineRange)
              : null
          return selected
        }, {}),
    })
  })

  return (
    <>
      <Show when={props.tab === REVIEW_TAB}>
        <div role="tabpanel" data-slot="tabs-content" class="flex h-full min-h-0 flex-col overflow-hidden">
          {props.reviewPanel()}
        </div>
      </Show>
      {/* Keep the file shell outside keyed tab content so its filter and sidebar scroll survive tab switches. */}
      <Show when={fileTabs().length > 0}>
        <div
          role="tabpanel"
          data-slot="tabs-content"
          class="h-full min-h-0 overflow-hidden"
          classList={{ hidden: !visible() }}
          inert={!visible() || undefined}
        >
          <SessionFileBrowserTab
            tab={browserTab() ?? SESSION_OPEN_FILE_TAB}
            placeholder={browserTab() === SESSION_OPEN_FILE_TAB}
            active={file.pathFromTab(browserTab() ?? "")}
            kinds={kinds()}
            state={props.state}
            onSelect={(path) => side.preview(file.tab(path))}
            onSelectPermanent={(path) => side.pin(file.tab(path))}
            filterRef={props.filterRef}
          />
        </div>
      </Show>
    </>
  )
}
