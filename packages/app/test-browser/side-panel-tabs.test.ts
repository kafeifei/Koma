import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSessionTabs } from "../src/pages/session/helpers"
import { REVIEW_TAB, childSessionTab, terminalTab } from "../src/pages/session/side-panel-tabs"

test("side content reacts to selection and layout changes without becoming a file tab", () => {
  createRoot((dispose) => {
    const [state, setState] = createStore({
      enabled: true,
      active: REVIEW_TAB,
      all: ["file://src/a.ts", REVIEW_TAB, childSessionTab("ses_child"), terminalTab("pty_1")],
    })
    const tabs = createSessionTabs({
      tabs: () => ({ active: () => state.active, all: () => state.all }),
      normalizeTab: (tab) => tab,
      pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice(7) : undefined),
      sidePanel: () => state.enabled,
    })
    expect(tabs.activeTab()).toBe(REVIEW_TAB)
    expect(tabs.activeFileTab()).toBeUndefined()
    expect(tabs.closableTab()).toBe(REVIEW_TAB)
    setState("active", terminalTab("pty_1"))
    expect(tabs.activeTab()).toBe(terminalTab("pty_1"))
    expect(tabs.activeFileTab()).toBeUndefined()
    setState("enabled", false)
    expect(tabs.panelTabs()).toEqual(["file://src/a.ts"])
    expect(tabs.activeTab()).toBe("file://src/a.ts")
    expect(tabs.activeFileTab()).toBe("file://src/a.ts")
    dispose()
  })
})
