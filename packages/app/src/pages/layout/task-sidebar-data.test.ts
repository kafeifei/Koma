import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import {
  filterClosedSessionDirectories,
  taskProjectGroups,
  taskSessionProjectDirectory,
  visibleTaskSessions,
} from "./task-sidebar-data"

const projects: LocalProject[] = [
  { id: "app", name: "App", worktree: "/app", expanded: true, sandboxes: ["/worktrees/app"] },
  { id: "site", name: "Website", worktree: "/site", expanded: true },
]

function session(id: string, directory = "/app", updated = 1): Session {
  return { id, slug: id, version: "", projectID: "app", directory, title: id, time: { created: 1, updated } }
}

describe("task sidebar project groups", () => {
  test("shows both historical project IDs under the same open root, including reclaimed worktrees", () => {
    const oldProject = { id: "old", worktree: "/app", expanded: true, sandboxes: ["/worktrees/old"] }
    const newProject = { id: "new", worktree: "/app/", expanded: true, sandboxes: ["/worktrees/new"] }
    const knownProjects = [oldProject, newProject]
    const saved = [
      { ...session("old", "/worktrees/old"), projectID: "old" },
      { ...session("new", "/worktrees/new"), projectID: "new" },
      { ...session("reclaimed", "/worktrees/reclaimed"), projectID: "new" },
    ]
    for (const opened of [oldProject, newProject]) {
      const groups = taskProjectGroups([opened], saved, "", { knownProjects })
      expect(groups).toHaveLength(1)
      expect(groups[0].sessions.map((item) => item.id)).toEqual(["new", "old", "reclaimed"])
    }
    expect(taskProjectGroups([oldProject], saved, "reclaimed", { knownProjects })[0].sessions).toEqual([saved[2]])
    const archived = { ...saved[2], time: { ...saved[2].time, archived: 2 } }
    expect(taskProjectGroups([oldProject], [archived], "", { archived: true, knownProjects })[0].sessions).toEqual([
      archived,
    ])
    expect(taskProjectGroups([], saved, "", { knownProjects })).toEqual([])
    expect(taskProjectGroups([projects[1]], saved, "", { knownProjects })[0].sessions).toEqual([])
  })

  test("groups both historical project identities, including reclaimed archived worktrees", () => {
    const known = [{ ...projects[0], projectIDs: ["app", "new-app"] }]
    const old = session("old")
    const current = { ...session("current", "/reclaimed"), projectID: "new-app" }
    const groups = taskProjectGroups(known, [old, current])
    expect(groups[0].sessions.map((item) => item.id).sort()).toEqual(["current", "old"])
    expect(
      taskProjectGroups(known, [{ ...current, time: { ...current.time, archived: 2 } }], "", { archived: true })[0]
        .sessions,
    ).toHaveLength(1)
  })
  test("keeps reclaimed archived checkouts under their project and respects project removal", () => {
    const known = [{ id: "app", worktree: "/app", expanded: true, sandboxes: [] }]
    const directory = taskSessionProjectDirectory(session("archived", "/worktrees/reclaimed"), known)
    expect(directory).toBe("/app")
    expect(filterClosedSessionDirectories([directory], ["/app"], known)).toEqual([])
    expect(taskSessionProjectDirectory({ projectID: "global", directory: "/separate" }, known)).toBe("/separate")
  })

  test("does not recreate recently closed projects from session directories", () => {
    expect(
      filterClosedSessionDirectories(
        ["/app", "/closed", "/other", "/worktrees/closed"],
        ["/closed"],
        [...projects, { worktree: "/closed", sandboxes: ["/worktrees/closed"] }],
      ),
    ).toEqual(["/app", "/other"])
  })

  test("does not merge unrelated non-Git directories through the shared global project ID", () => {
    const project = { id: "global", worktree: "/opened", expanded: true }
    const groups = taskProjectGroups(
      [project],
      [
        { ...session("here", "/opened"), projectID: "global" },
        { ...session("elsewhere", "/closed"), projectID: "global" },
      ],
    )
    expect(groups[0].sessions.map((item) => item.id)).toEqual(["here"])
  })

  test("groups worktree sessions under the project and prefers exact directory over a shared project ID", () => {
    const groups = taskProjectGroups(projects, [session("worktree", "/worktrees/app"), session("site", "/site")])
    expect(groups.map((group) => [group.project.worktree, group.sessions.map((item) => item.id)])).toEqual([
      ["/app", ["worktree"]],
      ["/site", ["site"]],
    ])
  })

  test("keeps empty open projects while excluding child, archived and unrelated sessions", () => {
    const groups = taskProjectGroups(projects, [
      { ...session("child"), parentID: "root" },
      { ...session("archived"), time: { created: 1, updated: 5, archived: 0 } },
      { ...session("closed", "/closed"), projectID: "closed" },
    ])
    expect(groups).toHaveLength(2)
    expect(groups.flatMap((group) => group.sessions)).toEqual([])
  })

  test("deduplicates summaries, sorts by last activity and uses a stable tie break", () => {
    const groups = taskProjectGroups(projects, [
      session("a"),
      session("c", "/app", 3),
      session("b", "/app", 3),
      session("a", "/app", 4),
    ])
    expect(groups[0].sessions.map((item) => item.id)).toEqual(["a", "b", "c"])
  })

  test("searches the whole supplied index by title or project instead of just visible rows", () => {
    const list = Array.from({ length: 30 }, (_, index) => session(`task ${index}`, "/app", 30 - index))
    expect(taskProjectGroups(projects, list, " TASK 29 ")[0].sessions.map((item) => item.id)).toEqual(["task 29"])
    expect(taskProjectGroups(projects, list, "App")[0].sessions).toHaveLength(30)
    expect(taskProjectGroups(projects, list, "missing")).toEqual([])
  })

  test("pins sort before newer tasks only inside their own project", () => {
    const groups = taskProjectGroups(
      projects,
      [session("new", "/app", 20), session("pinned"), session("site", "/site", 30)],
      "",
      { pinned: ["pinned"] },
    )
    expect(groups.map((group) => group.sessions.map((item) => item.id))).toEqual([["pinned", "new"], ["site"]])
  })

  test("body hits merge with title hits and archive scope still applies", () => {
    const archived = { ...session("archived"), time: { created: 1, updated: 2, archived: 0 } }
    const list = [session("needle"), session("body"), archived]
    expect(
      taskProjectGroups(projects, list, "needle", { matches: ["body", "archived"] })[0].sessions.map((item) => item.id),
    ).toEqual(["body", "needle"])
    expect(taskProjectGroups(projects, list, "needle", { archived: true, matches: ["archived"] })[0].sessions).toEqual([
      archived,
    ])
  })
})

describe("visible task sessions", () => {
  test("keeps an older selected task visible without duplicating it or mutating the index", () => {
    const list = [session("new"), session("middle"), session("old")]
    expect(visibleTaskSessions(list, 1, "old").map((item) => item.id)).toEqual(["new", "old"])
    expect(visibleTaskSessions(list, 1, "new").map((item) => item.id)).toEqual(["new"])
    expect(visibleTaskSessions(list, 1, "deleted").map((item) => item.id)).toEqual(["new"])
    expect(list).toHaveLength(3)
  })
})
