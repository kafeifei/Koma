import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, batch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { ServerScope } from "@/utils/server-scope"
import { usePlatform } from "./platform"
import type { RemoteAccessState } from "@/remote-access"

type StoredProject = { worktree: string; expanded: boolean }
export type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
type ServerProjectState = {
  projects: Record<string, StoredProject[]>
  lastProject: Record<string, string>
  recentlyClosed: Record<string, string[]>
  sessionProjects?: Record<string, Record<string, string | null>>
}
const HEALTH_POLL_INTERVAL_MS = 10_000
// The store retains more history than is displayed. Consumers filter recently closed entries
// against the live project list (dropping deleted projects) and then cap the visible count via
// RECENTLY_CLOSED_DISPLAY_LIMIT. Retaining extra history ensures entries that are temporarily
// filtered out do not evict still-visible ones from the persisted store.
const RECENTLY_CLOSED_HISTORY_LIMIT = 16
export const RECENTLY_CLOSED_DISPLAY_LIMIT = 5

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function migrateCanonicalLocalServerState(value: unknown, canonicalLocalServer?: ServerConnection.Key) {
  if (!canonicalLocalServer || canonicalLocalServer === "local") return value
  if (!isRecord(value)) return value
  const projects = isRecord(value.projects) ? value.projects : undefined
  const lastProject = isRecord(value.lastProject) ? value.lastProject : undefined
  const previousProjects = projects?.[canonicalLocalServer]
  const previousLastProject = lastProject?.[canonicalLocalServer]
  const sessionProjects = isRecord(value.sessionProjects) ? value.sessionProjects : undefined
  const previousAssignments = sessionProjects?.[canonicalLocalServer]
  if (!Array.isArray(previousProjects) && typeof previousLastProject !== "string" && !isRecord(previousAssignments))
    return value

  const next = { ...value }
  if (projects && Array.isArray(previousProjects)) {
    const local = Array.isArray(projects.local) ? projects.local : []
    const worktrees = new Set(
      local.flatMap((project) => (isRecord(project) && typeof project.worktree === "string" ? [project.worktree] : [])),
    )
    const migrated = previousProjects.filter((project) => {
      if (!isRecord(project) || typeof project.worktree !== "string") return true
      if (worktrees.has(project.worktree)) return false
      worktrees.add(project.worktree)
      return true
    })
    const nextProjects: Record<string, unknown> = { ...projects, local: [...local, ...migrated] }
    delete nextProjects[canonicalLocalServer]
    next.projects = nextProjects
  }
  if (lastProject && typeof previousLastProject === "string") {
    const nextLastProject = { ...lastProject }
    if (typeof nextLastProject.local !== "string") nextLastProject.local = previousLastProject
    delete nextLastProject[canonicalLocalServer]
    next.lastProject = nextLastProject
  }
  if (sessionProjects && isRecord(previousAssignments)) {
    const local = isRecord(sessionProjects.local) ? sessionProjects.local : {}
    const migrated: Record<string, unknown> = { ...sessionProjects, local: { ...previousAssignments, ...local } }
    delete migrated[canonicalLocalServer]
    next.sessionProjects = migrated
  }
  return next
}

export function createServerProjects<T extends ServerProjectState>(input: {
  scope: Accessor<ServerScope>
  store: Store<T>
  setStore: SetStoreFunction<T>
}) {
  const setStore = input.setStore as unknown as SetStoreFunction<ServerProjectState>
  const current = () => input.store.projects[input.scope()] ?? []
  const currentClosed = () => input.store.recentlyClosed?.[input.scope()] ?? []
  const remove = (directory: string) => {
    const key = pathKey(directory)
    setStore(
      "projects",
      input.scope(),
      current().filter((project) => pathKey(project.worktree) !== key),
    )
  }
  return {
    list: current,
    assignments: () => input.store.sessionProjects?.[input.scope()] ?? {},
    assign(id: string, project: string | null) {
      setStore(
        produce((state) => {
          const scopes = (state.sessionProjects ??= {})
          ;(scopes[input.scope()] ??= {})[id] = project
        }),
      )
    },
    remember(changes: Record<string, string | null>) {
      if (!Object.keys(changes).length) return
      setStore(
        produce((state) => {
          const assignments = (state.sessionProjects ??= {})
          const current = (assignments[input.scope()] ??= {})
          for (const [id, project] of Object.entries(changes)) {
            if (current[id] === undefined) current[id] = project
          }
        }),
      )
    },
    recentlyClosed: currentClosed,
    remove,
    open(directory: string) {
      const scope = input.scope()
      const key = pathKey(directory)
      const closed = currentClosed()
      if (closed.some((worktree) => pathKey(worktree) === key)) {
        setStore(
          "recentlyClosed",
          scope,
          closed.filter((worktree) => pathKey(worktree) !== key),
        )
      }
      if (current().some((project) => pathKey(project.worktree) === key)) return
      setStore("projects", scope, [{ worktree: directory, expanded: true }, ...current()])
    },
    // User-initiated close: removes the project and records it in recently closed.
    // Internal, non-user removals (e.g. sandbox/worktree normalization) should use remove().
    close(directory: string) {
      const scope = input.scope()
      const key = pathKey(directory)
      setStore(
        produce((state) => {
          state.projects[scope] = (state.projects[scope] ?? []).filter((project) => pathKey(project.worktree) !== key)
          state.recentlyClosed[scope] = [
            directory,
            ...(state.recentlyClosed[scope] ?? []).filter((path) => pathKey(path) !== key),
          ].slice(0, RECENTLY_CLOSED_HISTORY_LIMIT)
          for (const [id, project] of Object.entries(state.sessionProjects?.[scope] ?? {})) {
            if (project !== null && pathKey(project) === key) state.sessionProjects![scope][id] = null
          }
          if (state.lastProject[scope] && pathKey(state.lastProject[scope]) === key) delete state.lastProject[scope]
        }),
      )
    },
    expand(directory: string) {
      const key = pathKey(directory)
      const index = current().findIndex((project) => pathKey(project.worktree) === key)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", true)
    },
    collapse(directory: string) {
      const key = pathKey(directory)
      const index = current().findIndex((project) => pathKey(project.worktree) === key)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", false)
    },
    move(directory: string, toIndex: number) {
      const key = pathKey(directory)
      const fromIndex = current().findIndex((project) => pathKey(project.worktree) === key)
      if (fromIndex === -1 || fromIndex === toIndex) return
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      setStore("projects", input.scope(), next)
    },
    last() {
      return input.store.lastProject[input.scope()]
    },
    touch(directory: string) {
      setStore("lastProject", input.scope(), directory)
    },
    normalize(resolve: (directory: string) => string) {
      const scope = input.scope()
      const list = current().reduce<StoredProject[]>((result, project) => {
        const worktree = resolve(project.worktree)
        const index = result.findIndex((item) => pathKey(item.worktree) === pathKey(worktree))
        if (index === -1) return [...result, { ...project, worktree }]
        if (!project.expanded || result[index]?.expanded) return result
        return result.map((item, current) => (current === index ? { ...item, expanded: true } : item))
      }, [])
      const closed = currentClosed().reduce<string[]>((result, directory) => {
        const worktree = resolve(directory)
        if (result.some((item) => pathKey(item) === pathKey(worktree))) return result
        return [...result, worktree]
      }, [])
      const last = input.store.lastProject[scope]
      const nextLast = last ? resolve(last) : undefined
      const assignments = input.store.sessionProjects?.[scope] ?? {}
      const resolvedAssignments = Object.fromEntries(
        Object.entries(assignments).map(([id, project]) => [id, project === null ? null : resolve(project)]),
      )
      const assignmentsChanged = Object.entries(resolvedAssignments).some(
        ([id, project]) => project !== assignments[id],
      )
      const projectsChanged =
        list.length !== current().length ||
        list.some(
          (project, index) =>
            project.worktree !== current()[index]?.worktree || project.expanded !== current()[index]?.expanded,
        )
      const closedChanged =
        closed.length !== currentClosed().length ||
        closed.some((directory, index) => directory !== currentClosed()[index])

      if (!projectsChanged && !closedChanged && !assignmentsChanged && nextLast === last) return
      batch(() => {
        if (projectsChanged) setStore("projects", scope, list)
        if (closedChanged) setStore("recentlyClosed", scope, closed)
        if (nextLast && nextLast !== last) setStore("lastProject", scope, nextLast)
        if (assignmentsChanged) setStore("sessionProjects", scope, resolvedAssignments)
      })
    },
  }
}

function storedConnection(value: StoredServer): ServerConnection.Http {
  return typeof value === "string"
    ? { type: "http", http: { url: value } }
    : "http" in value
      ? value
      : { type: "http", http: value }
}

/** Upgrade only ports recorded by our native clients; leave ordinary HTTP servers alone. */
export function migrateRemoteServers(stored: StoredServer[], state: RemoteAccessState) {
  let changed = false
  const list = stored.flatMap((value) => {
    const conn = storedConnection(value)
    const known = conn.remote
      ? state.connections?.find((item) => item.id === conn.remote!.id && item.clientID === conn.remote!.clientID)
      : state.connections?.find((item) => item.url === normalizeServerUrl(conn.http.url))
    if (known?.current) {
      changed = true
      return []
    }
    if (conn.remote || !known) return [value]
    changed = true
    return [{ ...conn, remote: { id: known.id, clientID: known.clientID, key: conn.http.url } }]
  })
  return changed ? list : stored
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
  clientID?: string
}): Array<ServerConnection.Any> {
  const deduped = new Map<ServerConnection.Key, ServerConnection.Any>(
    input.props?.map((v) => [ServerConnection.key(v), v]) ?? [],
  )

  for (const value of input.stored) {
    const conn = storedConnection(value)
    if (conn.remote && conn.remote.clientID !== input.clientID) continue
    const key = ServerConnection.key(conn)

    const existing = deduped.get(key)
    if (existing)
      deduped.set(key, {
        ...existing,
        ...conn,
        http: { ...existing.http, ...conn.http },
      })
    else deduped.set(key, conn)
  }

  return [...deduped.values()]
}

export namespace ServerConnection {
  type Base = { displayName?: string; label?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
    remote?: { id: string; clientID: string; key?: string }
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.remote?.key ?? conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }

  export const builtin = (conn: Any) => conn.type === "sidecar" && conn.variant === "base"
  export const local = (conn?: Any) =>
    !!conn && (builtin(conn) || (conn.type === "http" && !conn.remote && isLocalHost(conn.http.url) === "local"))
}

export function nextServerAfterRemoval(
  servers: ServerConnection.Any[],
  removed: ServerConnection.Key,
  fallback: ServerConnection.Key,
) {
  const remaining = servers.filter((server) => ServerConnection.key(server) !== removed)
  const next = remaining.find((server) => ServerConnection.key(server) === fallback) ?? remaining[0]
  return next ? ServerConnection.key(next) : fallback
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  gate: true,
  init: (props: {
    defaultServer: ServerConnection.Key
    canonicalLocalServer?: ServerConnection.Key
    servers?: Array<ServerConnection.Any>
  }) => {
    const platform = usePlatform()
    const [remoteState, setRemoteState] = createSignal<RemoteAccessState>()
    const [remoteLoaded, setRemoteLoaded] = createSignal(!platform.remoteAccess)
    const [revisions, setRevisions] = createStore<Record<string, number>>({})
    const requests = new Map<string, number>()
    const restoring = new Set<string>()
    let disposed = false
    onCleanup(() => {
      disposed = true
    })
    onMount(() => {
      const remote = platform.remoteAccess
      if (!remote) return
      const update = (state: RemoteAccessState) => {
        if (disposed) return
        setRemoteState(state)
        setRemoteLoaded(true)
      }
      onCleanup(remote.subscribe(update))
      void remote
        .getState()
        .then(update)
        .catch(() => setRemoteLoaded(true))
    })
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("server", ["server.v3"]),
        migrate: (value) => migrateCanonicalLocalServerState(value, props.canonicalLocalServer),
      },
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        recentlyClosed: {} as Record<string, string[]>,
        sessionProjects: {} as Record<string, Record<string, string | null>>,
      }),
    )

    const storedKey = (x: StoredServer) => ServerConnection.key(storedConnection(x))

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      return resolveServerList({
        stored: remoteLoaded() ? store.list : [],
        props: props.servers,
        clientID: remoteState()?.clientID,
      })
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
    })

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      const previous =
        input.remote &&
        store.list
          .map(storedConnection)
          .find((conn) => conn.remote?.id === input.remote!.id && conn.remote.clientID === input.remote!.clientID)
      const conn: ServerConnection.Http = {
        ...input,
        authToken: undefined,
        http: { ...input.http, url: url_ },
        ...(input.remote
          ? { remote: { ...input.remote, key: previous ? ServerConnection.key(previous) : (input.remote.key ?? url_) } }
          : {}),
      }
      return batch(() => {
        const existing = store.list.findIndex((x) => storedKey(x) === ServerConnection.key(conn))
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const next = nextServerAfterRemoval(allServers(), key, props.defaultServer)
      const conn = allServers().find((item) => ServerConnection.key(item) === key)
      requests.set(key, (requests.get(key) ?? 0) + 1)
      const list = store.list.filter((x) => storedKey(x) !== key)
      if (conn?.type === "http" && conn.remote) {
        void platform.remoteAccess?.disconnect(conn.remote.id).catch(() => {})
      }
      batch(() => {
        setStore("list", list)
        if (state.active === key) setState("active", next)
      })
    }

    async function reconnect(key: ServerConnection.Key, force = true) {
      const conn = allServers().find((item) => ServerConnection.key(item) === key)
      const remote = platform.remoteAccess
      if (conn?.type !== "http" || !conn.remote || !remote) return
      const revision = (requests.get(key) ?? 0) + 1
      requests.set(key, revision)
      if (force) await remote.disconnect(conn.remote.id)
      const result = await remote.connect(conn.remote.id)
      if (disposed || requests.get(key) !== revision) return
      const index = store.list.findIndex((item) => storedKey(item) === key)
      if (index === -1) return
      // Keep the original server key so routes, project history and drafts survive a port change.
      batch(() => {
        setStore("list", index, { ...conn, remote: { ...conn.remote!, key }, http: { ...conn.http, url: result.url } })
        setRevisions(key, (revisions[key] ?? 0) + 1)
      })
    }

    createEffect(() => {
      const state = remoteState()
      if (!ready() || !state) return
      const list = migrateRemoteServers(store.list, state)
      if (list !== store.list) setStore("list", list)
      if (!state.account) return
      for (const value of list) {
        const conn = storedConnection(value)
        if (!conn.remote || conn.remote.clientID !== state.clientID) continue
        const identity = `${state.account.username}:${conn.remote.clientID}:${conn.remote.id}`
        if (restoring.has(identity)) continue
        restoring.add(identity)
        void untrack(() => reconnect(ServerConnection.key(conn), false)).catch(() => {})
      }
    })

    const isReady = Object.assign(
      createMemo(() => ready() && remoteLoaded() && !!state.active),
      { promise: ready.promise },
    )

    const scope = (key = state.active) => ServerScope.fromServerKey(key, props.canonicalLocalServer)
    const projects = createServerProjects({ scope, store, setStore })
    const projectStores = new Map<ServerConnection.Key, ReturnType<typeof createServerProjects>>()
    const projectsForServer = (key: ServerConnection.Key) => {
      const existing = projectStores.get(key)
      if (existing) return existing
      const next = createServerProjects({ scope: () => scope(key), store, setStore })
      projectStores.set(key, next)
      return next
    }
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const isLocal = createMemo(() => ServerConnection.local(current()))

    return {
      ready: isReady,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      remove,
      reconnect,
      revision: (key: ServerConnection.Key) => revisions[key] ?? 0,
      scope,
      projects: {
        ...projects,
        forServer: projectsForServer,
      },
    }
  },
})
