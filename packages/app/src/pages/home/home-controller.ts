import { useGlobal } from "@/context/global"
import { type HomeProjectSelection, useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { toggleHomeProjectSelection } from "@/pages/layout/helpers"
import { createEffect, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { createHomeSessionQuery } from "@/context/global-sync/home-session-query"
import { RECENT, recentGroup } from "@/utils/session-project"

export function createHomeController() {
  const sync = useServerSync()
  const layout = useLayout()
  const server = useServer()
  const global = useGlobal()
  const tabs = useTabs()
  const language = useLanguage()
  const selection = layout.home.selection
  const focusedServer = createMemo(
    () => global.servers.list().find((conn) => ServerConnection.key(conn) === selection().server) ?? server.current,
  )
  const focusedServerCtx = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })
  const focusedSync = () => focusedServerCtx()?.sync ?? sync()
  const sessions = createHomeSessionQuery(focusedServerCtx)
  const recent = createMemo(() => recentGroup(language.t("workspace.recent")))
  const projects = createMemo(() => {
    const ctx = focusedServerCtx()
    const opened = ctx?.projects.list() ?? layout.projects.list()
    return ctx && sessions.sessions().some((session) => !session.parentID && !ctx.projects.forSession(session))
      ? [recent(), ...opened]
      : opened
  })
  const recentlyClosed = createMemo(
    () => focusedServerCtx()?.projects.recentlyClosed() ?? layout.projects.recentlyClosed(),
  )
  const homedir = createMemo(() => focusedSync().data.path.home ?? "")
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      focusedServerCtx()?.projects.list()[0] ??
      recent(),
  )

  createEffect(() => {
    const list = global.servers.list()
    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  async function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    const ctx = global.ensureServerCtx(conn)
    if (directory !== RECENT && !(await ctx.projects.open(directory))) return
    const tab = await tabs.newDraft({
      server: ServerConnection.key(conn),
      directory: directory === RECENT ? undefined : directory,
    })
    if (tab && directory !== RECENT) ctx.projects.touch(tab.directory)
  }

  return {
    selection: {
      value: selection,
      set: setSelection,
      focusServer: (conn: ServerConnection.Any) => setSelection({ server: ServerConnection.key(conn) }),
    },
    server: {
      list: global.servers.list,
      health: (conn: ServerConnection.Any) => global.servers.health[ServerConnection.key(conn)],
      context: (conn: ServerConnection.Any) => global.ensureServerCtx(conn),
      focused: focusedServer,
      focusedContext: focusedServerCtx,
      focusedSync,
    },
    project: {
      list: projects,
      recentlyClosed,
      homedir,
      selected: selectedProject,
      newSession: newSessionProject,
      forServer: (conn: ServerConnection.Any) => global.ensureServerCtx(conn).projects.list(),
      select: (conn: ServerConnection.Any, directory: string) => {
        const key = ServerConnection.key(conn)
        if (global.servers.health[key]?.healthy === false) return
        if (
          directory !== RECENT &&
          !global
            .ensureServerCtx(conn)
            .projects.list()
            .some((project) => project.worktree === directory)
        )
          return
        setSelection(toggleHomeProjectSelection(selection(), key, directory))
      },
      add: async (conn: ServerConnection.Any, selected: string[]) => {
        const ctx = global.ensureServerCtx(conn)
        const directories = await Promise.all(selected.map((directory) => ctx.sdk.resolveDirectory(directory))).catch(
          (cause: unknown) => {
            showToast({
              title: language.t("common.requestFailed"),
              description: cause instanceof Error ? cause.message : language.t("common.requestFailed"),
            })
          },
        )
        if (!directories) return
        const directory = directories[0]
        if (!directory) return
        for (const item of directories) {
          if (ctx.projects.list().some((project) => project.worktree === item)) continue
          const location = { directory: item }
          void ctx.sdk.api.file
            .list({ path: ".", location })
            .then(async (files) => {
              if (files.data.length > 0) return ctx.sdk.api.project.current({ location })
              const result = await ctx.sdk.client.project.initGit({ directory: item })
              return result.data ?? ctx.sdk.api.project.current({ location })
            })
            .then((project) => ctx.sync.child(item, { bootstrap: false })[1]("project", project.id))
            .catch(() => undefined)
          if (!(await ctx.projects.open(item))) return
        }
        ctx.projects.touch(directory)
        setSelection({ server: ServerConnection.key(conn), directory })
      },
      openNewSession: () => {
        const conn = focusedServer()
        const project = newSessionProject()
        if (!conn) return
        if (project) return openProjectNewSession(conn, project.worktree)
        return tabs.newDraft({ server: ServerConnection.key(conn) })
      },
      openProjectNewSession,
    },
  }
}

export type HomeController = ReturnType<typeof createHomeController>
