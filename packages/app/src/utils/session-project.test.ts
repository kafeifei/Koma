import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createServerProjects } from "@/context/server"
import { ServerScope } from "@/utils/server-scope"
import { taskProjectGroups, taskSessionProjectDirectory } from "@/pages/layout/task-sidebar-data"
import { buildHomeSessionRecords } from "@/pages/home/home-session-records"
import { recentGroup, rememberSessionProjects, sessionProject, RECENT } from "./session-project"
import type { Session } from "@opencode-ai/sdk/v2/client"

const project = { id: "repo", worktree: "/repo", expanded: true, sandboxes: ["/worktree"] }
const session = (id: string, directory: string, projectID = "repo"): Session => ({
  id,
  directory,
  projectID,
  slug: id,
  title: id,
  version: "1",
  time: { created: 1, updated: 1 },
})

describe("session presentation membership", () => {
  test("closing and reopening a project retains detached tasks and their execution roots", () =>
    createRoot((dispose) => {
      const [state, setState] = createStore({ projects: {}, recentlyClosed: {}, lastProject: {} })
      const projects = createServerProjects({ store: state, setStore: setState, scope: () => ServerScope.local })
      projects.open(project.worktree)
      const tasks = [
        session("active", "/worktree"),
        { ...session("archived", "/reclaimed"), time: { created: 1, updated: 1, archived: 2 } },
      ]
      projects.remember(rememberSessionProjects(tasks, [project], [project], projects.assignments()))
      projects.close("/repo/")
      expect(projects.list()).toEqual([])
      expect(projects.assignments()).toEqual({ active: null, archived: null })
      projects.open("/repo")
      projects.remember(
        rememberSessionProjects([...tasks, session("new", "/repo")], [project], [project], projects.assignments()),
      )
      expect(sessionProject(tasks[0], [project], [project], projects.assignments())).toBeUndefined()
      expect(sessionProject(session("new", "/repo"), [project], [project], projects.assignments())).toEqual(project)
      expect(tasks[0].directory).toBe("/worktree")
      expect(taskSessionProjectDirectory(tasks[0], [project])).toBe("/repo")
      dispose()
    }))

  test("home and sidebar include every unassigned root once, with no synthetic runtime project", () => {
    const recent = recentGroup("Recent")
    const orphan = session("orphan", "/elsewhere", "global")
    const detached = session("detached", "/worktree")
    const child = { ...session("child", "/elsewhere"), parentID: "orphan" }
    const tasks = [orphan, detached, session("normal", "/repo"), child]
    const assignments = { detached: null }
    const groups = taskProjectGroups([recent, project], tasks, "", { assignments, knownProjects: [project] })
    expect(groups.map((group) => [group.project.worktree, group.sessions.map((s) => s.id)])).toEqual([
      [RECENT, ["detached", "orphan"]],
      ["/repo", ["normal"]],
    ])
    const records = buildHomeSessionRecords({
      sessions: () => tasks.filter((s) => !s.parentID),
      projects: () => [recent, project],
      projectDirectories: () => [RECENT, "/repo"],
      projectByID: () => new Map([["repo", project]]),
      assignments: () => assignments,
    })
    expect(records.map((r) => [r.session.id, r.project.worktree])).toEqual([
      ["detached", RECENT],
      ["normal", "/repo"],
      ["orphan", RECENT],
    ])
    expect(recent.id).toBeUndefined()
    expect(taskProjectGroups([recent], [])).toEqual([])
  })

  test("adding a directory does not absorb explicitly projectless history", () => {
    const task = session("old", "/repo")
    const assignments = rememberSessionProjects([task], [], [project], {})
    expect(assignments).toEqual({ old: null })
    expect(rememberSessionProjects([task], [project], [project], assignments)).toEqual({})
    expect(sessionProject(task, [project], [project], assignments)).toBeUndefined()
  })
})
