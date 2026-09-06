import { For, Show, createMemo, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { createElementSize } from "@solid-primitives/resize-observer"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Mark } from "@opencode-ai/ui/logo"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { useTitlebarRightMount } from "@/components/titlebar"
import { SessionContextUsage } from "@/components/session-context-usage"
import { FileVisual, SessionContextTab, SortableTabV2 } from "@/components/session"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { SESSION_OPEN_FILE_TAB } from "@/context/layout-tabs"
import { createSessionOwnership } from "./session-ownership"
import { useSessionLayout } from "./session-layout"
import { SidePanelAddMenu, SidePanelContent, SidePanelTabLabel } from "./side-panel-content"
import { REVIEW_TAB, sidePanelTab } from "./side-panel-tabs"
import { useSidePanel } from "./use-side-panel"
import type { SessionFileBrowserState } from "./v2/session-file-browser-tab"
import { WorkspaceFiles } from "./workspace-files"
import "./side-panel-tabs.css"

export function SessionWorkspace(props: {
  canReview: () => boolean
  diffs: () => (FileDiffInfo | SnapshotFileDiff | VcsFileDiff)[]
  reviewPanel: () => JSX.Element
  fileBrowserState: SessionFileBrowserState
}) {
  const language = useLanguage()
  const file = useFile()
  const side = useSidePanel()
  const { sessionKey, tabs, view } = useSessionLayout()
  const ownership = createSessionOwnership(sessionKey)
  const titlebarMount = useTitlebarRightMount("opencode-titlebar-side-panel")
  const [elements, setElements] = createStore({
    tabs: undefined as HTMLDivElement | undefined,
    filter: undefined as HTMLInputElement | undefined,
  })
  const tabSize = createElementSize(() => elements.tabs)
  const all = () => tabs().all()
  const active = createMemo(() => {
    const value = tabs().active()
    return value && all().includes(value) ? value : all()[0]
  })
  const preview = () => tabs().preview()
  const opened = () => view().workspacePanel.opened()
  const visibleTabs = createMemo(() => {
    const capacity = Math.max(1, Math.floor((tabSize.width ?? 480) / 48))
    if (all().length <= capacity) return all()
    const visible = all().slice(0, capacity)
    const selected = active()
    if (selected && !visible.includes(selected)) visible[capacity - 1] = selected
    return visible
  })
  const detail = createMemo(() => {
    const value = active()
    return value && value !== REVIEW_TAB && sidePanelTab(value) ? value : undefined
  })
  const label = (tab: string) => {
    if (tab === "context") {
      return (
        <span class="flex min-w-0 items-center gap-1.5">
          <SessionContextUsage variant="indicator" />
          <span class="truncate">{language.t("session.tab.context")}</span>
        </span>
      )
    }
    if (tab === SESSION_OPEN_FILE_TAB) {
      return (
        <span class="flex min-w-0 items-center gap-1.5 italic">
          <Icon name="open-file" size="small" />
          <span class="truncate">{language.t("command.file.open")}</span>
        </span>
      )
    }
    if (sidePanelTab(tab)) return <SidePanelTabLabel tab={tab} temporary={preview() === tab} />
    return <FileVisual path={file.pathFromTab(tab) ?? tab} temporary={preview() === tab} />
  }
  const openFile = () => {
    const owner = ownership.capture()
    side.openFile()
    queueMicrotask(() => owner.run(() => elements.filter?.focus()))
  }

  return (
    <aside
      id="side-workspace-panel"
      aria-label={language.t("session.panel.workspace")}
      aria-hidden={!opened()}
      inert={!opened()}
      class="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden border-s border-border-weaker-base bg-v2-background-bg-base"
    >
      <Show when={opened()}>
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                event.target instanceof Element && !!event.target.closest('[data-slot="tabs-trigger-close-button"]'),
            }),
          ]}
          modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => elements.tabs ?? null })]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragEnd={(event) => {
            const source = event.operation.source
            if (event.canceled || !isSortable(source) || source.initialIndex === source.index) return
            tabs().move(source.id.toString(), source.index)
          }}
        >
          <Tabs value={active()} onChange={side.activate}>
            <Show when={titlebarMount()} keyed>
              {(mount) => (
                <Portal mount={mount}>
                  <div class="session-side-panel-top-tabs">
                    <Tabs.List ref={(element: HTMLDivElement) => setElements("tabs", element)}>
                      {/* Keep hidden tabs registered: removing the selected trigger makes Kobalte select another tab. */}
                      <For each={all()}>
                        {(tab) => (
                          <SortableTabV2
                            tab={tab}
                            index={() => all().indexOf(tab)}
                            hidden={!visibleTabs().includes(tab)}
                            temporary={preview() === tab}
                            label={label(tab)}
                            onTabClose={side.close}
                            onTabClick={preview() === tab ? side.pin : undefined}
                          />
                        )}
                      </For>
                    </Tabs.List>
                    <div
                      class="session-side-panel-actions flex h-full shrink-0 items-center justify-center"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <SidePanelAddMenu
                        onOpenFile={openFile}
                        onOpenReview={side.openReview}
                        canReview={props.canReview()}
                      />
                    </div>
                    <MenuV2 placement="bottom-end" gutter={6} modal={false}>
                      <MenuV2.Trigger
                        as={IconButtonV2}
                        icon={<Icon name="chevron-down" />}
                        variant="ghost-muted"
                        size="large"
                        aria-label={language.t("session.panel.allTabs")}
                      />
                      <MenuV2.Portal>
                        <MenuV2.Content class="max-h-80 overflow-y-auto">
                          <For each={all()}>
                            {(tab) => (
                              <div
                                class="flex min-w-0 items-center"
                                data-slot="side-panel-tab-menu-row"
                                data-value={tab}
                              >
                                <MenuV2.Item
                                  class="min-w-0 flex-1"
                                  onSelect={() => {
                                    side.activate(tab)
                                    if (preview() === tab) side.pin(tab)
                                  }}
                                >
                                  <span class="min-w-0 flex-1 truncate">{label(tab)}</span>
                                  <Show when={active() === tab}>
                                    <Icon name="check" size="small" />
                                  </Show>
                                </MenuV2.Item>
                                <IconButton
                                  icon="close-small"
                                  variant="ghost"
                                  aria-label={language.t("common.closeTab")}
                                  onClick={() => side.close(tab)}
                                />
                              </div>
                            )}
                          </For>
                        </MenuV2.Content>
                      </MenuV2.Portal>
                    </MenuV2>
                  </div>
                </Portal>
              )}
            </Show>
            <Show when={!active()}>
              <div class="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
                <Mark class="w-14 opacity-10" />
                <div class="max-w-56 text-14-regular text-text-weak">{language.t("session.panel.add")}</div>
              </div>
            </Show>
            <Show when={active() === "context"}>
              <div role="tabpanel" data-slot="tabs-content" class="h-full min-h-0 overflow-hidden">
                <SessionContextTab />
              </div>
            </Show>
            <Show when={detail() ? `${sessionKey()}:${detail()}` : undefined} keyed>
              {(_key) => {
                const tab = detail()!
                return (
                  <div role="tabpanel" data-slot="tabs-content" class="h-full min-h-0 overflow-hidden">
                    <SidePanelContent tab={tab} />
                  </div>
                )
              }}
            </Show>
            <WorkspaceFiles
              tab={active()}
              diffs={props.diffs}
              reviewPanel={props.reviewPanel}
              state={props.fileBrowserState}
              filterRef={(element) => setElements("filter", element)}
            />
          </Tabs>
        </DragDropProvider>
      </Show>
    </aside>
  )
}
