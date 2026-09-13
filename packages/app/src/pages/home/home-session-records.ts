import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { compareSessionTime, displayName, projectForSession } from "@/pages/layout/helpers"
import { pathKey } from "@/utils/path-key"

export function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
  knownProjects?: () => Array<Pick<LocalProject, "id" | "worktree" | "sandboxes">>
}) {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const sessions = input.sessions()
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort(compareSessionTime)
    .flatMap((session) => {
      const directory = pathKey(session.directory)
      const project =
        input
          .projects()
          .find(
            (item) =>
              pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
          ) ?? projectForSession(session, input.projects(), input.projectByID(), input.knownProjects?.())
      if (!project) return []
      if (!directories.has(directory) && !directories.has(pathKey(project.worktree))) return []
      return { session, project, projectName: displayName(project) }
    })
}
