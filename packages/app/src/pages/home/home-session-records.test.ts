import { expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { buildHomeSessionRecords } from "./home-session-records"

test("home includes historical project IDs while respecting the selected and closed projects", () => {
  const opened = [
    { id: "old", worktree: "/app", expanded: true },
    { id: "global", worktree: "/notes", expanded: true },
  ]
  const saved: Session[] = [
    {
      id: "new",
      slug: "new",
      version: "",
      projectID: "new",
      directory: "/worktrees/new",
      title: "New task",
      time: { created: 1, updated: 1 },
    },
    {
      id: "elsewhere",
      slug: "elsewhere",
      version: "",
      projectID: "global",
      directory: "/elsewhere",
      title: "Closed task",
      time: { created: 1, updated: 1 },
    },
  ]
  const input = {
    sessions: () => saved,
    projects: () => opened,
    projectByID: () => new Map(opened.map((project) => [project.id, project])),
    knownProjects: () => [...opened, { id: "new", worktree: "/app" }],
    projectDirectories: () => ["/app", "/notes"],
  }
  expect(buildHomeSessionRecords(input).map((record) => [record.session.id, record.project.worktree])).toEqual([
    ["new", "/app"],
  ])
  expect(buildHomeSessionRecords({ ...input, projectDirectories: () => ["/notes"] })).toEqual([])
  expect(buildHomeSessionRecords({ ...input, projects: () => [], projectByID: () => new Map() })).toEqual([])
})
