import { describe, expect, test } from "bun:test"
import {
  filterPromptProjectTargets,
  promptProjectTarget,
  promptProjectTargets,
  type PromptProject,
} from "./prompt-project-selector"

const projects: PromptProject[] = [
  {
    id: "project",
    name: "OpenCode Lab",
    worktree: "/code/opencode",
    sandboxes: ["/data/worktree/kind-wolf", "/data/worktree/quiet-engine"],
  },
  { id: "other", name: "Other", worktree: "/code/other", sandboxes: ["/data/worktree/kind-wolf"] },
]

describe("prompt project targets", () => {
  test("exposes one canonical directory for each project", () => {
    expect(promptProjectTargets(projects).map((target) => target.directory)).toEqual(["/code/opencode", "/code/other"])
  })

  test("finds the canonical project by an existing worktree name", () => {
    expect(filterPromptProjectTargets(projects, "quiet-engine").map((target) => target.directory)).toEqual([
      "/code/opencode",
    ])
  })

  test("maps the current worktree to its canonical project target", () => {
    expect(promptProjectTarget(projects, "/data/worktree/quiet-engine")?.directory).toBe("/code/opencode")
  })

  test("keeps one project entry when its project name matches", () => {
    expect(filterPromptProjectTargets(projects, "OpenCode Lab")).toHaveLength(1)
  })

  test("does not map an arbitrary subdirectory to a project", () => {
    expect(promptProjectTarget(projects, "/code/opencode/packages/app")).toBeUndefined()
  })
})
