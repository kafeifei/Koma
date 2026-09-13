import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { projectForSession } from "@/pages/layout/helpers"
import { pathKey } from "./path-key"

// A presentation group, never a runtime Project or an execution directory.
export const RECENT = "koma:recent"
export type SessionProjects = Record<string, string | null>
type KnownProject = Pick<LocalProject, "id" | "worktree" | "sandboxes">

export function recentGroup(name: string): LocalProject {
  return { worktree: RECENT, name, expanded: true, internal: "recent" }
}

export function sessionProject(
  session: Pick<Session, "id" | "projectID" | "directory">,
  projects: LocalProject[],
  knownProjects: KnownProject[] = [],
  assignments: SessionProjects = {},
) {
  const assigned = assignments[session.id]
  if (assigned === null) return undefined
  const opened = projects.filter((project) => project.worktree !== RECENT)
  if (assigned !== undefined) return opened.find((project) => pathKey(project.worktree) === pathKey(assigned))
  const directory = pathKey(session.directory)
  return (
    opened.find(
      (project) =>
        pathKey(project.worktree) === directory || project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
    ) ?? projectForSession(session, opened, new Map(opened.flatMap((p) => (p.id ? [[p.id, p]] : []))), knownProjects)
  )
}

export function rememberSessionProjects(
  sessions: Array<Pick<Session, "id" | "parentID" | "projectID" | "directory">>,
  projects: LocalProject[],
  knownProjects: KnownProject[],
  assignments: SessionProjects,
) {
  const changes: SessionProjects = {}
  for (const session of sessions) {
    if (session.parentID || assignments[session.id] !== undefined) continue
    changes[session.id] = sessionProject(session, projects, knownProjects)?.worktree ?? null
  }
  return changes
}
