import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { getToolInfo } from "@opencode-ai/session-ui/message-part"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useTerminal } from "@/context/terminal"
import { useServerSync } from "@/context/server-sync"
import { BackgroundTasksPanel, ChildSessionPanel, ToolInspectorPanel } from "./inspector-panels"
import { sidePanelTab, terminalTab } from "./side-panel-tabs"
import { useSidePanel } from "./use-side-panel"
import { useSessionLayout } from "./session-layout"
import { terminalTabLabel } from "./terminal-label"
import { TerminalPanelV2 } from "./terminal-panel-v2"

export function SidePanelAddMenu(props: { onOpenFile: () => void }) {
  const language = useLanguage()
  const side = useSidePanel()
  const terminal = useTerminal()
  const { tabs } = useSessionLayout()
  const hiddenTerminals = createMemo(() => terminal.all().filter((pty) => !tabs().all().includes(terminalTab(pty.id))))
  return (
    <MenuV2 placement="bottom-end" gutter={6} modal={false}>
      <MenuV2.Trigger
        as={IconButtonV2}
        icon={<Icon name="plus-small" />}
        variant="ghost-muted"
        size="large"
        aria-label={language.t("session.panel.add")}
      />
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.Item onSelect={() => void side.openTerminal(true)}>
            <Icon name="terminal" />
            {language.t("terminal.title")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={props.onOpenFile}>
            <Icon name="open-file" />
            {language.t("command.file.open")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={side.openBackground}>
            <Icon name="bullet-list" />
            {language.t("session.panel.background")}
          </MenuV2.Item>
          <Show when={hiddenTerminals().length > 0}>
            <MenuV2.Separator />
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("session.panel.existingTerminals")}</MenuV2.GroupLabel>
              <For each={hiddenTerminals()}>
                {(pty) => (
                  <MenuV2.Item onSelect={() => side.openExistingTerminal(pty.id)}>
                    <Icon name="terminal" />
                    {terminalTabLabel({ title: pty.title, titleNumber: pty.titleNumber, t: language.t })}
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
          </Show>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

export function SidePanelTabLabel(props: { tab: string; temporary?: boolean }) {
  const language = useLanguage()
  const terminal = useTerminal()
  const sync = useServerSync()
  const target = createMemo(() => sidePanelTab(props.tab))
  const title = createMemo(() => {
    const item = target()
    if (!item) return ""
    if (item.type === "background") return language.t("session.panel.background")
    if (item.type === "terminal") {
      const pty = terminal.all().find((pty) => pty.id === item.id)
      return terminalTabLabel({ title: pty?.title ?? "", titleNumber: pty?.titleNumber ?? 0, t: language.t })
    }
    if (item.type === "session") return sync().session.get(item.sessionID)?.title ?? language.t("session.panel.child")
    const part = sync().session.data.part[item.messageID]?.find((part) => part.id === item.partID)
    if (part?.type !== "tool") return language.t("session.panel.tool")
    return getToolInfo(part.tool, part.state.input, "metadata" in part.state ? part.state.metadata : undefined).title
  })
  return (
    <span class="flex min-w-0 items-center gap-1.5" title={title()}>
      <Icon
        name={target()?.type === "terminal" ? "terminal" : target()?.type === "session" ? "subagent" : "bullet-list"}
        size="small"
      />
      <span class="max-w-40 truncate text-14-medium" classList={{ italic: props.temporary }}>
        {title()}
      </span>
    </span>
  )
}

export function SidePanelContent(props: { tab: string }) {
  const side = useSidePanel()
  const layout = useLayout()
  const terminal = useTerminal()
  const language = useLanguage()
  const { sessionKey } = useSessionLayout()
  const target = createMemo(() => sidePanelTab(props.tab))
  const terminalTarget = createMemo(() => {
    const item = target()
    return item?.type === "terminal" ? item : undefined
  })
  const tool = createMemo(() => {
    const item = target()
    return item?.type === "tool" ? item : undefined
  })
  const child = createMemo(() => {
    const item = target()
    return item?.type === "session" ? item : undefined
  })
  return (
    <div class="h-full min-h-0 overflow-hidden" data-component="side-panel-content" data-panel-type={target()?.type}>
      <Switch>
        <Match when={target()?.type === "background"}>
          <BackgroundTasksPanel onTool={side.inspectTool} onSession={side.previewSession} />
        </Match>
        <Match when={tool()}>{(item) => <ToolInspectorPanel {...item()} />}</Match>
        <Match when={child()}>
          {(item) => (
            <ChildSessionPanel sessionID={item().sessionID} onTool={side.inspectTool} onSession={side.previewSession} />
          )}
        </Match>
        <Match when={terminalTarget()}>
          {(item) => {
            const ownerTabs = layout.tabs(sessionKey())
            return (
              <Show
                when={terminal.all().some((pty) => pty.id === item().id)}
                fallback={
                  <div class="flex h-full items-center justify-center text-12-regular text-text-weak">
                    {language.t("session.panel.terminalClosed")}
                  </div>
                }
              >
                <TerminalPanelV2
                  terminalID={item().id}
                  onTerminalReplaced={(previous, next) => {
                    const active = ownerTabs.active()
                    ownerTabs.setAll(
                      ownerTabs.all().map((tab) => (tab === terminalTab(previous) ? terminalTab(next) : tab)),
                    )
                    if (active === terminalTab(previous)) ownerTabs.setActive(terminalTab(next))
                  }}
                />
              </Show>
            )
          }}
        </Match>
      </Switch>
    </div>
  )
}
