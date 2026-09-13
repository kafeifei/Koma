import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { pathKey } from "@/utils/path-key"
import { compareSessionTime, displayName, projectForSession } from "./helpers"

export function taskProjectGroups(
  projects: LocalProject[],
  sessions: Session[],
  query = "",
  options: {
    archived?: boolean
    pinned?: string[]
    matches?: string[]
    knownProjects?: Array<Pick<LocalProject, "id" | "worktree" | "sandboxes">>
  } = {},
) {
  const search = query.trim().toLowerCase()
  const groups = projects.map((project) => ({ project, sessions: [] as Session[] }))
  const byID = new Map(projects.flatMap((project) => (project.id ? [[project.id, project] as const] : [])))
  const roots = [...new Map(sessions.map((session) => [session.id, session])).values()]
    .filter((session) => !session.parentID && (typeof session.time.archived === "number") === !!options.archived)
    .sort(
      (a, b) =>
        Number(options.pinned?.includes(b.id) ?? false) - Number(options.pinned?.includes(a.id) ?? false) ||
        compareSessionTime(a, b),
    )

  for (const session of roots) {
    const directory = pathKey(session.directory)
    const project =
      projects.find(
        (item) => pathKey(item.worktree) === directory || item.sandboxes?.some((path) => pathKey(path) === directory),
      ) ?? projectForSession(session, projects, byID, options.knownProjects)
    const group = groups.find((item) => item.project === project)
    if (!group) continue
    if (
      search &&
      !`${session.title} ${displayName(group.project)}`.toLowerCase().includes(search) &&
      !options.matches?.includes(session.id)
    )
      continue
    group.sessions.push(session)
  }

  return search
    ? groups.filter((group) => group.sessions.length > 0 || displayName(group.project).toLowerCase().includes(search))
    : groups
}

// Archived checkouts can disappear from Project.sandboxes; the durable project ID still identifies their root.
export function taskSessionProjectDirectory(
  session: Pick<Session, "directory" | "projectID">,
  projects: Array<Pick<LocalProject, "id" | "worktree" | "sandboxes">>,
) {
  const directory = pathKey(session.directory)
  const project =
    projects.find(
      (item) =>
        pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
    ) ?? (session.projectID === "global" ? undefined : projects.find((item) => item.id === session.projectID))
  return project?.worktree ?? session.directory
}

export function filterClosedSessionDirectories(
  directories: string[],
  recentlyClosed: string[],
  projects: Array<Pick<LocalProject, "worktree" | "sandboxes">>,
) {
  const closed = new Set(recentlyClosed.map(pathKey))
  const excluded = new Set(
    [
      ...recentlyClosed,
      ...projects.flatMap((project) => {
        if (!closed.has(pathKey(project.worktree))) return []
        return [project.worktree, ...(project.sandboxes ?? [])]
      }),
    ].map(pathKey),
  )
  return [...new Set(directories)].filter((directory) => {
    return !excluded.has(pathKey(directory))
  })
}

export function visibleTaskSessions(sessions: Session[], limit: number, activeID?: string) {
  const visible = sessions.slice(0, limit)
  const active = sessions.find((session) => session.id === activeID)
  if (!active || visible.some((session) => session.id === active.id)) return visible
  return [...visible, active]
}
