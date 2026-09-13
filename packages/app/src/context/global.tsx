import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createServerProjects, RECENTLY_CLOSED_DISPLAY_LIMIT, ServerConnection, useServer } from "./server"
import { pathKey } from "@/utils/path-key"
import { useServerHealth } from "@/utils/server-health"
import { createServerSdkContext } from "./server-sdk"
import { createServerSyncContext } from "./server-sync"
import { getOwner } from "solid-js/web"
import { QueryClient } from "@tanstack/solid-query"
import type { ServerScope } from "@/utils/server-scope"
import { Persist, persisted } from "@/utils/persist"
import { createOpenedProjectResolver, dedupeOpenedProjects, openedProjectMetadata } from "./global-sync/utils"

export const { use: useGlobal, provider: GlobalProvider } = createSimpleContext({
  name: "Global",
  init: () => {
    const server = useServer()
    const serverHealth = useServerHealth(
      () => server.list,
      () => true,
    )
    const [store, setStore] = createStore({
      settings: {
        serverKey: undefined as ServerConnection.Key | undefined,
      },
    })

    const settingsServer = createMemo(() => {
      const list = server.list
      return list.find((conn) => ServerConnection.key(conn) === store.settings.serverKey) ?? list[0]
    })

    createEffect(() => {
      const conn = settingsServer()
      const key = conn ? ServerConnection.key(conn) : undefined
      if (store.settings.serverKey !== key) setStore("settings", "serverKey", key)
    })

    const serverCtxs = new Map<
      ServerConnection.Key,
      { dispose: () => void; serverCtx: ReturnType<typeof createServerCtx>; url: string; revision: number }
    >()

    const owner = getOwner()

    const ensureServerCtx = (conn: ServerConnection.Any) => {
      const key = ServerConnection.key(conn)
      const existing = serverCtxs.get(key)
      const revision = server.revision(key)
      if (existing && existing.url === conn.http.url && existing.revision === revision) return existing.serverCtx
      existing?.dispose()
      const root = createRoot((dispose) => {
        const serverCtx = createServerCtx(conn, server.scope(key), server.projects.forServer(key), server.ready)
        return { dispose, serverCtx, url: conn.http.url, revision }
      }, owner as any)
      serverCtxs.set(key, root)
      return root.serverCtx
    }

    createMemo(() => {
      for (const conn of server.list) {
        ensureServerCtx(conn)
      }
    })

    createEffect(() => {
      for (const [key] of serverCtxs) {
        if (!server.list.find((conn) => ServerConnection.key(conn) === key)) {
          const { dispose } = serverCtxs.get(key)!
          dispose()
          serverCtxs.delete(key)
        }
      }
    })

    return {
      servers: {
        list: () => server.list,
        health: serverHealth,
      },
      settings: {
        server: {
          get key() {
            return store.settings.serverKey
          },
          selected: settingsServer,
          set(key: ServerConnection.Key) {
            if (store.settings.serverKey !== key) setStore("settings", "serverKey", key)
          },
        },
      },
      ensureServerCtx(conn: ServerConnection.Any) {
        return ensureServerCtx(conn)
      },
    }
  },
})

function createServerCtx(
  conn: ServerConnection.Any,
  scope: ServerScope,
  projects: ReturnType<typeof createServerProjects>,
  serverReady: () => boolean,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  const sdk = createServerSdkContext(conn, scope)
  const sync = createServerSyncContext(sdk)
  const [tasks, setTasks, , tasksReady] = persisted(
    Persist.serverGlobal(scope, "task-workspace"),
    createStore({ pinned: [] as string[] }),
  )

  const resolveProject = createMemo(() => createOpenedProjectResolver(sync.data.project))

  createEffect(() => {
    if (!serverReady() || !sync.ready) return
    projects.normalize(resolveProject())
  })

  function enrich(project: { worktree: string; expanded: boolean }) {
    const [childStore] = sync.child(project.worktree, { bootstrap: false })
    const projectID = childStore.project
    const worktree = resolveProject()(project.worktree)
    const metadata = openedProjectMetadata(sync.data.project, worktree, projectID)
    const [projectStore] = worktree === project.worktree ? [childStore] : sync.child(worktree, { bootstrap: false })

    // Preserve local icon override from the canonical project's per-workspace localStorage cache.
    // Without this, different subdirectories of the same git repo would share the same
    // icon from the database instead of using their individual overrides.
    const base = { ...metadata, ...project, worktree }
    if (projectStore.icon) {
      return { ...base, icon: { ...base.icon, override: projectStore.icon } }
    }
    return base
  }

  const projectsList = createMemo(() => dedupeOpenedProjects(projects.list().map(enrich)))
  const recentlyClosedList = createMemo(() => {
    const known = new Set(sync.data.project.map((project) => pathKey(project.worktree)))
    return projects
      .recentlyClosed()
      .filter((worktree) => known.has(pathKey(worktree)))
      .slice(0, RECENTLY_CLOSED_DISPLAY_LIMIT)
      .map((worktree) => enrich({ worktree, expanded: false }))
  })

  const isLocal = ServerConnection.local(conn)

  return {
    queryClient,
    sdk,
    sync,
    isLocal,
    tasks: {
      ready: tasksReady,
      pinned: () => tasks.pinned,
      togglePin(sessionID: string) {
        if (!tasksReady()) return
        setTasks("pinned", (ids) =>
          ids.includes(sessionID) ? ids.filter((id) => id !== sessionID) : [...ids, sessionID],
        )
      },
    },
    projects: {
      ...projects,
      list: projectsList,
      recentlyClosed: recentlyClosedList,
      remove(directory: string) {
        projects.remove(resolveProject()(directory))
      },
      open(directory: string) {
        projects.open(resolveProject()(directory))
      },
      close(directory: string) {
        projects.close(resolveProject()(directory))
      },
      expand(directory: string) {
        projects.expand(resolveProject()(directory))
      },
      collapse(directory: string) {
        projects.collapse(resolveProject()(directory))
      },
      move(directory: string, toIndex: number) {
        projects.move(resolveProject()(directory), toIndex)
      },
      touch(directory: string) {
        projects.touch(resolveProject()(directory))
      },
    },
  }
}

export type ServerCtx = ReturnType<typeof createServerCtx>

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}
