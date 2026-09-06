import { useLayout } from "@/context/layout"
import { useTerminal } from "@/context/terminal"
import { createSessionOwnership } from "./session-ownership"
import { useSessionLayout } from "./session-layout"
import { BACKGROUND_TASKS_TAB, childSessionTab, sidePanelTab, terminalTab, toolDetailTab } from "./side-panel-tabs"
import type { ToolPart } from "@opencode-ai/sdk/v2"

export function useSidePanel() {
  const layout = useLayout()
  const terminal = useTerminal()
  const { sessionKey, tabs, view, params } = useSessionLayout()
  const ownership = createSessionOwnership(sessionKey)

  const activate = (tab: string) => {
    const target = sidePanelTab(tab)
    tabs().setActive(tab)
    view().reviewPanel.open()
    if (target?.type === "terminal" && terminal.all().some((pty) => pty.id === target.id)) {
      terminal.open(target.id)
      terminal.requestFocus(target.id)
    }
  }

  const preview = (tab: string) => {
    tabs().previewTab(tab)
    activate(tab)
  }

  const openTerminal = async (create = false) => {
    const owner = ownership.capture()
    const targetTabs = layout.tabs(sessionKey())
    const current = !create && (terminal.all().find((pty) => pty.id === terminal.active()) ?? terminal.all()[0])
    const id = current ? current.id : await terminal.new()
    if (!id) return
    await targetTabs.open(terminalTab(id))
    owner.run(() => activate(terminalTab(id)))
  }

  const close = (tab: string) => {
    const target = sidePanelTab(tab)
    if (target?.type === "terminal" && terminal.all().some((pty) => pty.id === target.id))
      void terminal.close(target.id)
    tabs().close(tab)
    const next = sidePanelTab(tabs().active())
    if (next?.type === "terminal" && terminal.all().some((pty) => pty.id === next.id)) {
      terminal.open(next.id)
      terminal.requestFocus(next.id)
    }
  }

  return {
    activate,
    close,
    preview,
    openTerminal,
    openExistingTerminal: (id: string) => {
      if (!terminal.all().some((pty) => pty.id === id)) return
      void tabs().open(terminalTab(id))
      activate(terminalTab(id))
    },
    toggleTerminal: () => {
      const target = sidePanelTab(tabs().active())
      if (target?.type === "terminal" && view().reviewPanel.opened()) {
        terminal.cancelFocus()
        view().reviewPanel.close()
        return
      }
      void openTerminal()
    },
    openBackground: () => {
      void tabs().open(BACKGROUND_TASKS_TAB)
      activate(BACKGROUND_TASKS_TAB)
    },
    inspectTool: (part: ToolPart) => {
      preview(toolDetailTab(part))
    },
    previewSession: (sessionID: string) => {
      preview(childSessionTab(sessionID))
      console.info(
        "[subagent-navigation]",
        JSON.stringify({
          phase: "activate",
          sessionID: params.id,
          targetSessionID: sessionID,
          selected: tabs().active() === childSessionTab(sessionID),
          opened: view().reviewPanel.opened(),
        }),
      )
    },
    pin: (tab: string) => {
      void tabs().open(tab)
      activate(tab)
    },
  }
}
