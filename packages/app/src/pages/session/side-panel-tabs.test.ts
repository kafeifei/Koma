import { describe, expect, test } from "bun:test"
import { closeSessionTab, openSessionTab, previewSessionTab, type SessionTabState } from "@/context/layout-tabs"
import {
  normalizeWorkspaceTabs,
  REVIEW_TAB,
  childSessionTab,
  sidePanelTab,
  terminalTab,
  toolDetailTab,
} from "./side-panel-tabs"

describe("side workspace tabs", () => {
  test("keeps Review in the ordinary close and reopen lifecycle", () => {
    const opened = openSessionTab({ tabs: { all: [terminalTab("pty_1")] } }, REVIEW_TAB)
    expect(opened.tabs.all).toEqual([terminalTab("pty_1"), REVIEW_TAB])
    const closed = closeSessionTab(opened, REVIEW_TAB)
    expect(closed.tabs.all).toEqual([terminalTab("pty_1")])
    expect(normalizeWorkspaceTabs(closed.tabs)).toEqual(closed.tabs)
    expect(openSessionTab(closed, REVIEW_TAB).tabs.active).toBe(REVIEW_TAB)
  })

  test("migrates old UI entries without reopening a closed review or dropping live targets", () => {
    const all = [terminalTab("pty_1"), childSessionTab("child"), "background-tasks"]
    expect(normalizeWorkspaceTabs({ all, active: "background-tasks" })).toEqual({
      all: all.slice(0, 2),
      active: all[0],
    })
    expect(normalizeWorkspaceTabs({ all: [], active: "review" })).toEqual({ all: [REVIEW_TAB], active: REVIEW_TAB })
    expect(normalizeWorkspaceTabs({ all: [] })).toEqual({ all: [], active: undefined })
    expect(sidePanelTab(REVIEW_TAB)).toEqual({ type: "review" })
  })

  test("restores typed targets without confusing files with inspection targets", () => {
    const part = { sessionID: "ses_parent", messageID: "msg_1", id: "prt_1" }
    expect(sidePanelTab(toolDetailTab(part))).toEqual({
      type: "tool",
      sessionID: part.sessionID,
      messageID: part.messageID,
      partID: part.id,
    })
    expect(sidePanelTab(childSessionTab("ses_child"))).toEqual({ type: "session", sessionID: "ses_child" })
    expect(sidePanelTab(terminalTab("pty_1"))).toEqual({ type: "terminal", id: "pty_1" })
    expect(sidePanelTab("file://src/session.tsx")).toBeUndefined()
    expect(sidePanelTab("tool://ses_parent/msg_1")).toBeUndefined()
    expect(sidePanelTab("terminal://")).toBeUndefined()
  })

  test("replaces a temporary detail while preserving a terminal, review and pinned detail", () => {
    const tool = toolDetailTab({ sessionID: "ses_1", messageID: "msg_1", id: "prt_1" })
    const state: SessionTabState = { tabs: { all: [terminalTab("pty_1"), REVIEW_TAB] } }
    const inspected = previewSessionTab(state, tool)
    const pinned = openSessionTab(inspected, tool)
    const child = previewSessionTab(pinned, childSessionTab("ses_child"))
    const file = previewSessionTab(child, "file://src/session.tsx")
    expect(file.tabs.all).toEqual([terminalTab("pty_1"), REVIEW_TAB, tool, "file://src/session.tsx"])
    expect(file.preview).toBe("file://src/session.tsx")
    expect(file.tabs.active).toBe("file://src/session.tsx")
  })
})
