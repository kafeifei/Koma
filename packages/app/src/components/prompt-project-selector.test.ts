import { describe, expect, test } from "bun:test"
import { filterPromptProjectTargets, promptProjectTargets, type PromptProject } from "./prompt-project-selector"

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
  test("exposes existing worktrees as directory entries under their project", () => {
    expect(promptProjectTargets(projects).map((target) => target.directory)).toEqual([
      "/code/opencode",
      "/data/worktree/kind-wolf",
      "/data/worktree/quiet-engine",
      "/code/other",
    ])
  })

  test("finds an existing worktree by its directory name", () => {
    expect(filterPromptProjectTargets(projects, "kind-wolf").map((target) => target.directory)).toEqual([
      "/data/worktree/kind-wolf",
    ])
  })

  test("shows a directory only once when project records overlap", () => {
    expect(promptProjectTargets(projects).filter((target) => target.directory.endsWith("kind-wolf"))).toHaveLength(1)
  })

  test("keeps all of a project's directory entries when its project name matches", () => {
    expect(filterPromptProjectTargets(projects, "OpenCode Lab")).toHaveLength(3)
  })
})
