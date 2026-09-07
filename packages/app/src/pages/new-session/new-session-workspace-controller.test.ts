import { describe, expect, test } from "bun:test"
import {
  resolveNewSessionBranch,
  resolveNewSessionIsolation,
  resolveNewSessionWorktree,
} from "./new-session-workspace-controller"

describe("new session workspace selection", () => {
  test("keeps the last isolation preference while options load or fail", () => {
    expect(
      resolveNewSessionIsolation({ visible: true, preferred: true, hasHead: false, loading: true, failed: false }),
    ).toBe(true)
    expect(
      resolveNewSessionIsolation({ visible: true, preferred: true, hasHead: false, loading: false, failed: true }),
    ).toBe(true)
  })

  test("disables isolation when the selected source cannot create a worktree", () => {
    expect(
      resolveNewSessionIsolation({ visible: true, preferred: true, hasHead: false, loading: false, failed: false }),
    ).toBe(false)
    expect(
      resolveNewSessionIsolation({ visible: false, preferred: true, hasHead: true, loading: false, failed: false }),
    ).toBe(false)
  })

  test("uses the last valid isolation choice when worktrees are available", () => {
    expect(
      resolveNewSessionIsolation({ visible: true, preferred: true, hasHead: true, loading: false, failed: false }),
    ).toBe(true)
    expect(
      resolveNewSessionIsolation({ visible: true, preferred: false, hasHead: true, loading: false, failed: false }),
    ).toBe(false)
    expect(resolveNewSessionWorktree(true)).toBe("create")
    expect(resolveNewSessionWorktree(false)).toBe("main")
  })

  test("keeps branch choice independent from isolation and falls back in product order", () => {
    const branches = ["release", "dev", "main", "feature"]
    expect(resolveNewSessionBranch({ selected: "release", branches, current: "feature" })).toBe("release")
    expect(resolveNewSessionBranch({ branches, current: "feature" })).toBe("main")
    expect(resolveNewSessionBranch({ branches: ["release", "dev", "feature"], current: "feature" })).toBe("dev")
    expect(resolveNewSessionBranch({ branches: ["release", "feature"], current: "feature" })).toBe("feature")
  })

  test("keeps a remembered branch when it is no longer in the current options", () => {
    expect(resolveNewSessionBranch({ selected: "deleted", branches: ["dev", "feature"], current: "feature" })).toBe(
      "deleted",
    )
  })
})
