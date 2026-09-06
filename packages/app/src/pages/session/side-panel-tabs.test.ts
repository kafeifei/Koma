import { describe, expect, test } from "bun:test"
import { openSessionTab, previewSessionTab, type SessionTabState } from "@/context/layout-tabs"
import { BACKGROUND_TASKS_TAB, childSessionTab, sidePanelTab, terminalTab, toolDetailTab } from "./side-panel-tabs"

describe("side workspace tabs", () => {
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

  test("replaces a temporary detail while preserving a terminal, list and pinned detail", () => {
    const tool = toolDetailTab({ sessionID: "ses_1", messageID: "msg_1", id: "prt_1" })
    const state: SessionTabState = { tabs: { all: [terminalTab("pty_1"), BACKGROUND_TASKS_TAB] } }
    const inspected = previewSessionTab(state, tool)
    const pinned = openSessionTab(inspected, tool)
    const child = previewSessionTab(pinned, childSessionTab("ses_child"))
    const file = previewSessionTab(child, "file://src/session.tsx")
    expect(file.tabs.all).toEqual([terminalTab("pty_1"), BACKGROUND_TASKS_TAB, tool, "file://src/session.tsx"])
    expect(file.preview).toBe("file://src/session.tsx")
    expect(file.tabs.active).toBe("file://src/session.tsx")
  })
})
