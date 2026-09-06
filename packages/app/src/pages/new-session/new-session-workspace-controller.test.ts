import { describe, expect, test } from "bun:test"
import {
  resolveNewSessionBaseBranch,
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

  test("shows the chosen starting branch only in isolation mode", () => {
    expect(resolveNewSessionBranch({ isolated: true, current: "feature", base: "dev" })).toBe("dev")
    expect(resolveNewSessionBranch({ isolated: false, current: "feature", base: "dev" })).toBe("feature")
  })

  test("falls back to the selected source's default starting branch", () => {
    expect(resolveNewSessionBaseBranch({ selected: "feature", fallback: "dev" })).toBe("feature")
    expect(resolveNewSessionBaseBranch({ fallback: "dev" })).toBe("dev")
  })
})
