import { Schema } from "effect"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useQueries } from "@tanstack/solid-query"
import type { SessionInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { displayName } from "@opencode/ui/project-avatar"
import { homeSessionsQuery } from "@/home/sessions/queries"
import { useLanguage } from "@/runtime/i18n/language"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal, type ServerCtx } from "@/runtime/server/runtime"
import type { Project } from "@/runtime/server/types"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { useSettingsSurface } from "@/settings/surface"
import { sessionStatus } from "@/shell/layout/project-avatar-state"
import { ProjectIcon } from "@/shell/layout/project-icon"
import { getCompactTime } from "@/shell/time"
import { createProjectSessionActions } from "@/shell/tabs/project-sessions"
import { tabKey, useTabs, type SessionTab, type Tab } from "@/shell/tabs/tabs"
import { PinMenuItems, PinnedArea, usePins } from "./pinned-area"
import { ProjectSessionRow } from "./project-session-row"
import { createSessionArchiver } from "./session-archive"
import { createMenuLetterKeys } from "./menu-keys"
import { isSidebarSessionActivity, mergeSidebarSessions } from "./sidebar-sessions"
import type { TabStripLeading, TabStripSection } from "./tab-strip"
import { SidebarViewMenu } from "./sidebar-view-menu"
import {
  SIDEBAR_GROUPINGS,
  SIDEBAR_ORDERINGS,
  sidebarView,
  type SidebarFilterKind,
  type SidebarFilters,
  type SidebarGroup,
  type SidebarRow,
  type SidebarStatus,
  type SidebarViewState,
} from "./sidebar-view"
import "./tab-nav.css"

const ViewState = Persistence.struct({
  grouping: Schema.Literals(SIDEBAR_GROUPINGS),
  ordering: Schema.Literals(SIDEBAR_ORDERINGS),
  show: Persistence.struct({
    recent: Schema.Boolean,
    subagents: Schema.Boolean,
    serverLabels: Schema.Boolean,
  }),
  collapsed: Persistence.record(Schema.Boolean),
})

const RECENT_STEP = 5

// One ungrouped list holds every project's sessions, so it shows more before "Show more".
const RECENT_STEP_UNGROUPED = 10

type Row = SidebarRow & {
  conn: ServerConnection.Any | undefined
  tab: Tab | undefined
  session: SessionInfo | undefined
  project: Project | undefined
}

type SectionFooter = { type: "group" | "row"; key: string }

type SectionPlan = {
  key: string
  tabs: Tab[]
  /** The key of the group the header shows. */
  header: string | undefined
  hideAvatars: boolean
  footer: SectionFooter | undefined
}

function sameList<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  return a === b || (!!a && !!b && a.length === b.length && a.every((item, index) => item === b[index]))
}

function samePlans(a: SectionPlan[], b: SectionPlan[]) {
  return (
    a.length === b.length &&
    a.every((plan, index) => {
      const other = b[index]

      return (
        plan.key === other.key &&
        plan.header === other.header &&
        plan.hideAvatars === other.hideAvatars &&
        plan.footer?.type === other.footer?.type &&
        plan.footer?.key === other.footer?.key &&
        sameList(plan.tabs, other.tabs)
      )
    })
  )
}

export type SidebarStripGrouping = {
  sections: TabStripSection[]
  tabFooter?: (tab: Tab) => JSX.Element | undefined
  tabLabel?: (tab: Tab) => string | undefined
  tabMenu?: (tab: SessionTab) => JSX.Element
  tabMuted?: (tab: SessionTab) => boolean
  leading?: TabStripLeading
  /** Koma: open tabs the strip leaves out, because the pinned area above it shows them. */
  hidden?: (tab: Tab) => boolean
}

/** The "Customize" vertical sidebar: open tabs and recent sessions from every server, grouped, sorted and filtered. */
export function SidebarCustomized(props: {
  currentTab: Tab | undefined
  onNewSession: () => void
  children: (strip: SidebarStripGrouping) => JSX.Element
}) {
  const language = useLanguage()

  const global = useGlobal()

  const servers = useServers()

  const settings = useSettings()

  const tabs = useTabs()

  const actions = createProjectSessionActions()

  const surface = useSettingsSurface()

  // Koma: pinned sessions sit in the pinned area above the groups, and every row's menu can pin and archive.
  const pins = usePins()
  const archive = createSessionArchiver()

  createMenuLetterKeys()

  // Built once: the strip renders it inside its scroll, and pinned sessions share the ⌘1–9 numbers with the tabs.
  const pinnedArea = <PinnedArea orientation="vertical" divider />

  const pinnedLeading = (): TabStripLeading | undefined =>
    pins.state.items.length === 0
      ? undefined
      : { content: pinnedArea, keys: pins.keys(), unread: pins.unread, navigate: pins.openKey }

  createSidebarActivityListener()

  // Ticks once a minute so the rows' relative times stay current while the sidebar is idle.
  const [clock, setClock] = createSignal(0)
  const clockTimer = setInterval(() => setClock((value) => value + 1), 60_000)
  onCleanup(() => clearInterval(clockTimer))

  const [view, setView] = persisted(Persist.global("sidebar.view"), ViewState, {
    grouping: "project",
    ordering: "manual",
    show: { recent: true, subagents: false, serverLabels: true },
    collapsed: {},
  })

  // Filters narrow the list for this window only; they reset on reload.
  const [local, setLocal] = createStore<{ filters: SidebarFilters; limits: Record<string, number> }>({
    filters: { status: [], server: [], project: [] },
    limits: {},
  })

  const connected = createMemo(() =>
    global.servers.list().filter((conn) => {
      const ctx = global.serverCtx(ServerConnection.key(conn))

      return ctx?.sdk.connection.status() === "connected"
    }),
  )

  const connOf = (server: string) => global.servers.list().find((conn) => ServerConnection.key(conn) === server)

  const ctxOf = (server: string) => {
    const conn = connOf(server)

    return conn ? global.serverCtx(ServerConnection.key(conn)) : undefined
  }

  const recentQueries = useQueries(() => ({
    queries: connected().map((conn) => homeSessionsQuery(conn, ctxOf(ServerConnection.key(conn)))),
  }))

  // Koma: the search box at the top of the sidebar narrows the groups to sessions whose title matches: the loaded
  // ones at once, and the rest of the server's list once it answers. The server searches titles only.
  const [search, setSearch] = createStore({ input: "", query: "" })
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  const typeSearch = (value: string) => {
    setSearch("input", value)
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => setSearch("query", value.trim()), 200)
  }

  const clearSearch = () => {
    clearTimeout(searchTimer)
    setSearch({ input: "", query: "" })
  }

  onCleanup(() => clearTimeout(searchTimer))

  const searching = () => search.query.length > 0

  const searchQueries = useQueries(() => ({
    queries: connected().map((conn) => {
      const ctx = ctxOf(ServerConnection.key(conn))
      const query = search.query

      return {
        queryKey: ["sidebar-search", conn, query] as const,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          ctx
            ? ctx.sdk.api.session
                .list({ parentID: null, search: query, archived: false, limit: 50 }, { signal })
                .then((response) => response.data)
            : Promise.resolve<SessionInfo[]>([]),
        enabled: !!ctx && query.length > 0,
        retry: false,
        gcTime: 30_000,
      }
    }),
  }))

  const titleMatches = (session: SessionInfo | undefined) =>
    !!session?.title && session.title.toLowerCase().includes(search.query.toLowerCase())

  // Server groupings only separate anything once a second server is added; the saved choice returns with it.
  const grouping = () =>
    global.servers.list().length > 1 || (view.grouping !== "server" && view.grouping !== "server-project")
      ? view.grouping
      : "project"

  const state = (): SidebarViewState => ({
    grouping: grouping(),
    ordering: view.ordering,
    show: view.show,
    filters: local.filters,
    // Koma: a search shows its matches wherever they are, so every group opens.
    collapsed: searching() ? {} : view.collapsed,
  })

  // Status is the one per-row read that walks the whole session store, so only work it out when it changes the view.
  const needsStatus = () => view.ordering === "attention" || local.filters.status.length > 0

  const status = (ctx: ServerCtx | undefined, session: SessionInfo | undefined): SidebarStatus => {
    if (!ctx || !session || !needsStatus()) return "idle"

    return sessionStatus(ctx, session.id, {
      root: !session.parentID,
      autoApprove: settings.permissions.autoApproves(projectSettingsKey(ctx.sdk.scope, session.projectID)),
      snapshot: session,
    })
  }

  const sessionRowKey = (server: string, sessionID: string) => `${server}\u0000${sessionID}`

  const rows = createMemo<Row[]>(() => {
    const current = props.currentTab

    const isActive = (server: string, sessionID: string) =>
      current?.type === "session" && current.server === server && current.sessionId === sessionID

    const openRows = tabs.store.map((tab, order): Row => {
      const ctx = ctxOf(tab.server)

      if (tab.type === "draft") {
        return {
          key: tabKey(tab),
          server: tab.server,
          projectID: ctx?.projects.forDirectory(tab.directory)?.id,
          project: ctx?.projects.forDirectory(tab.directory),
          open: true,
          active: current === tab,
          parentKey: undefined,
          status: "idle",
          updated: 0,
          created: 0,
          order,
          conn: connOf(tab.server),
          tab,
          session: undefined,
        }
      }

      const session = ctx?.data.session.get(tab.sessionId)

      const directory = session?.location.directory ?? tabs.info[tabKey(tab)]?.directory

      const project = session
        ? ctx?.projects.forSession(session)
        : directory
          ? ctx?.projects.forDirectory(directory)
          : undefined

      return {
        key: sessionRowKey(tab.server, tab.sessionId),
        server: tab.server,
        projectID: project?.id,
        project,
        open: true,
        active: isActive(tab.server, tab.sessionId),
        parentKey: undefined,
        status: status(ctx, session),
        updated: session?.time.updated ?? 0,
        created: session?.time.created ?? 0,
        order,
        conn: connOf(tab.server),
        tab,
        session,
      }
    })

    const found = new Map<string, Set<string>>(
      connected().map((conn, index) => [
        ServerConnection.key(conn),
        new Set((searchQueries[index]?.data ?? []).map((session) => session.id)),
      ]),
    )

    const matches = (server: string, session: SessionInfo | undefined) =>
      !!session && (titleMatches(session) || !!found.get(server)?.has(session.id))

    const shownOpenRows = searching() ? openRows.filter((row) => matches(row.server, row.session)) : openRows
    const openKeys = new Set(shownOpenRows.map((row) => row.key))

    const sessionRows = connected().flatMap((conn, index) => {
      const server = ServerConnection.key(conn)

      const ctx = ctxOf(server)

      if (!ctx) return []
      const recent = recentQueries[index]?.data?.() ?? []
      const known = mergeSidebarSessions(recent, ctx.data.session.known())
      const hits = searchQueries[index]?.data ?? []

      // `apply` drops sessions being deleted or already deleted, which the fetched lists still hold until they refetch.
      const indexed = ctx.data.session.apply(
        searching()
          ? [...hits, ...known.filter((session) => titleMatches(session) && !hits.some((hit) => hit.id === session.id))]
          : known,
      )

      const children = view.show.subagents
        ? ctx.data.session.list().filter((session) => !!session.parentID && session.time.archived === undefined)
        : []

      return [...indexed, ...children].flatMap((session): Row[] => {
        const key = sessionRowKey(server, session.id)

        if (openKeys.has(key)) return []

        if (pins.pinned({ server: ServerConnection.Key.make(server), sessionId: session.id })) return []
        const project = ctx.projects.forSession(session)

        return [
          {
            key,
            server,
            projectID: project?.id,
            project,
            open: false,
            active: isActive(server, session.id),
            parentKey: session.parentID ? sessionRowKey(server, session.parentID) : undefined,
            status: status(ctx, session),
            updated: session.time.updated,
            created: session.time.created,
            order: 0,
            conn,
            tab: undefined,
            session,
          },
        ]
      })
    })

    return [...shownOpenRows, ...sessionRows]
  })

  const result = createMemo(() => sidebarView(rows(), state()))

  const groups = createMemo(() => result().groups.flatMap((group) => [group, ...(group.children ?? [])]))

  const visibleRows = () => groups().flatMap((group) => group.rows)

  // A project that spans servers takes its name and icon from the current server's copy when there is one.
  const projectLabels = createMemo(() => {
    const byID = new Map<string, Project>()

    global.servers.list().forEach((conn) => {
      ctxOf(ServerConnection.key(conn))
        ?.projects.list()
        .forEach((project) => {
          if (!byID.has(project.id) || servers.current(conn)) byID.set(project.id, project)
        })
    })

    return byID
  })

  const serverOptions = () =>
    global.servers.list().map((conn) => ({ key: ServerConnection.key(conn), label: servers.label(conn) }))

  const projectOptions = () =>
    [...projectLabels().values()].map((project) => ({ id: project.id, label: displayName(project) }))

  const serverLabel = (row: Row, group: SidebarGroup<Row> | undefined) => {
    if (!view.show.serverLabels || !row.conn) return

    if (group && group.kind !== "all" && !group.spansServers) return

    return servers.tag(row.conn)
  }

  // Koma: a row that has no server to name says when its session last changed, as an agent list does.
  const showLabel = (row: Row, group: SidebarGroup<Row> | undefined) => {
    const server = serverLabel(row, group)

    if (server || !row.updated) return server
    clock()

    return getCompactTime(row.updated, language.t)
  }

  const rowByKey = createMemo(() => new Map(visibleRows().map((row) => [row.key, row])))

  const groupByKey = createMemo(() => new Map(groups().map((group) => [group.key, group])))

  const groupByRow = createMemo(
    () => new Map(groups().flatMap((group) => group.rows.map((row) => [row.key, group] as const))),
  )

  const groupOf = (key: string) => groupByRow().get(key)

  // Every row whose top-level ancestor is an open tab renders under that tab; the rest render in the group's footer.
  const anchorOf = (row: Row, byKey: Map<string, Row>): Row => {
    const parent = row.parentKey ? byKey.get(row.parentKey) : undefined

    return parent ? anchorOf(parent, byKey) : row
  }

  const depthOf = (row: Row, byKey: Map<string, Row>): number => {
    const parent = row.parentKey ? byKey.get(row.parentKey) : undefined

    return parent ? depthOf(parent, byKey) + 1 : 0
  }

  const openSession = (row: Row) => {
    if (!row.conn || !row.session) return
    actions.openProjectSession(row.conn, row.project?.worktree ?? row.session.location.directory, row.session, {
      preview: true,
    })
  }

  const rowMenu = (server: string, session: SessionInfo) => (
    <>
      <PinMenuItems pin={{ server: ServerConnection.Key.make(server), sessionId: session.id }} />
      <Menu.Item
        data-action="sidebar-session-archive"
        data-menu-key="a"
        shortcut="A"
        onSelect={() => archive(server, session)}
      >
        {language.t("common.archive")}
      </Menu.Item>
    </>
  )

  const tabMenu = (tab: SessionTab) => {
    const session = ctxOf(tab.server)?.data.session.get(tab.sessionId)

    return session ? rowMenu(tab.server, session) : undefined
  }

  // Rows outside a project group carry their project's avatar, as open tabs always do; subagents follow their parent.
  const avatarOf = (row: Row, group: SidebarGroup<Row> | undefined) => {
    if (group?.kind === "project" || row.parentKey || !row.projectID) return

    return projectLabels().get(row.projectID) ?? row.project
  }

  // Rows render from their key and read the live row, so a session update changes props in place instead of rebuilding them.
  function SessionRowItem(rowProps: { rowKey: string; flat?: boolean }) {
    const row = () => rowByKey().get(rowProps.rowKey)

    const item = () => {
      const value = row()

      return value?.session && value.conn ? { row: value, session: value.session, conn: value.conn } : undefined
    }

    const group = () => groupOf(rowProps.rowKey)

    return (
      <Show when={item()}>
        {(value) => (
          <ProjectSessionRow
            server={ServerConnection.key(value().conn)}
            session={value().session}
            openTab={false}
            active={value().row.active}
            label={showLabel(value().row, group())}
            depth={rowProps.flat ? 0 : depthOf(value().row, rowByKey())}
            project={avatarOf(value().row, group())}
            menuItems={() => rowMenu(ServerConnection.key(value().conn), value().session)}
            onOpen={() => openSession(value().row)}
          />
        )}
      </Show>
    )
  }

  // A collapsed group keeps the current session visible below its header.
  const activeRecent = (group: SidebarGroup<Row>): SectionFooter | undefined => {
    const row = group.rows.find((item) => item.active && !item.open)

    return row ? { type: "row", key: row.key } : undefined
  }

  function GroupFooter(footerProps: { groupKey: string }) {
    const footer = createMemo(
      () => {
        const group = groupByKey().get(footerProps.groupKey)

        if (!group) return { keys: [], more: false, limit: 0, step: 0 }

        const footerRows = group.rows.filter((row) => !anchorOf(row, rowByKey()).open)

        const topLevel = footerRows.filter((row) => anchorOf(row, rowByKey()) === row)

        const step = group.kind === "all" ? RECENT_STEP_UNGROUPED : RECENT_STEP

        // Koma: a search lists every match; "Show more" is for browsing.
        const limit = searching() ? Number.POSITIVE_INFINITY : (local.limits[group.key] ?? step)

        const shown = new Set(topLevel.slice(0, limit))

        return {
          keys: footerRows.filter((row) => shown.has(anchorOf(row, rowByKey()))).map((row) => row.key),
          more: topLevel.length > limit,
          limit,
          step,
        }
      },
      undefined,
      { equals: (a, b) => sameList(a.keys, b.keys) && a.more === b.more && a.limit === b.limit && a.step === b.step },
    )

    return (
      <>
        <For each={footer().keys}>{(key) => <SessionRowItem rowKey={key} />}</For>
        <Show when={footer().more}>
          <Button
            variant="ghost-muted"
            size="small"
            class="ms-[23px] self-start"
            onClick={() => setLocal("limits", footerProps.groupKey, footer().limit + footer().step)}
          >
            {language.t("sidebar.organize.showMore")}
          </Button>
        </Show>
      </>
    )
  }

  const leafPlan = (group: SidebarGroup<Row>): SectionPlan => ({
    key: group.key,
    tabs: group.rows.flatMap((row) => (row.open && row.tab && (!group.collapsed || row.active) ? [row.tab] : [])),
    header: group.kind === "all" ? undefined : group.key,
    hideAvatars: group.kind === "project",
    footer: group.collapsed ? activeRecent(group) : { type: "group", key: group.key },
  })

  // Only the shape of the sidebar lives here. Headers and footers read their data live, so a session update that
  // leaves the shape alone keeps every header and row mounted, with its hover, focus, menus and dialogs.
  const plans = createMemo(
    () =>
      result().groups.flatMap((group): SectionPlan[] => {
        if (!group.children) return [leafPlan(group)]

        // Server → Project keeps every row at one inset: the server reads as a section label above its projects.
        if (!group.collapsed)
          return [
            { key: group.key, tabs: [], header: group.key, hideAvatars: false, footer: undefined },
            ...group.children.map(leafPlan),
          ]

        const active = group.children.find((child) => child.rows.some((row) => row.active))

        return [
          {
            key: group.key,
            tabs: active ? active.rows.flatMap((row) => (row.active && row.open && row.tab ? [row.tab] : [])) : [],
            header: group.key,
            hideAvatars: false,
            footer: active ? activeRecent(active) : undefined,
          },
        ]
      }),
    undefined,
    { equals: samePlans },
  )

  const sections = createMemo(() =>
    plans().map(
      (plan): TabStripSection => ({
        key: plan.key,
        tabs: plan.tabs,
        header: plan.header ? <GroupHeader groupKey={plan.header} /> : undefined,
        hideAvatars: plan.hideAvatars,
        footer:
          plan.footer?.type === "group" ? (
            <GroupFooter groupKey={plan.footer.key} />
          ) : plan.footer ? (
            <SessionRowItem rowKey={plan.footer.key} flat />
          ) : undefined,
      }),
    ),
  )

  // Row keys of the sessions that render under each open tab (its subagents).
  const tabChildren = createMemo(
    () => {
      const out = new Map<string, string[]>()

      result().groups.forEach((parent) => {
        if (parent.collapsed) return
        ;(parent.children ?? [parent]).forEach((group) => {
          if (group.collapsed) return

          group.rows.forEach((row) => {
            const anchor = anchorOf(row, rowByKey())

            if (anchor !== row && anchor.open) out.set(anchor.key, [...(out.get(anchor.key) ?? []), row.key])
          })
        })
      })

      return out
    },
    undefined,
    { equals: (a, b) => a.size === b.size && [...a].every(([key, keys]) => sameList(keys, b.get(key))) },
  )

  const tabFooter = (tab: Tab) => {
    if (tab.type !== "session") return

    const children = createMemo(() => tabChildren().get(sessionRowKey(tab.server, tab.sessionId)), undefined, {
      equals: sameList,
    })

    if (!children()) return

    return <For each={children()}>{(key) => <SessionRowItem rowKey={key} />}</For>
  }

  const tabLabel = (tab: Tab) => {
    const key = tab.type === "session" ? sessionRowKey(tab.server, tab.sessionId) : tabKey(tab)

    const row = rows().find((item) => item.key === key)

    return row ? showLabel(row, groupOf(key)) : undefined
  }

  function GroupHeader(headerProps: { groupKey: string }) {

    return (
      <Show when={groupByKey().get(headerProps.groupKey)}>{(group) => <GroupHeaderView group={group()} />}</Show>
    )
  }

  function GroupHeaderView(headerProps: { group: SidebarGroup<Row> }) {
    const group = () => headerProps.group

    const section = () => !!group().children

    const project = () => (group().kind === "project" ? projectLabels().get(group().id) : undefined)

    const label = () => {
      if (group().kind === "server") {
        const conn = connOf(group().id)

        return conn ? servers.label(conn) : group().id
      }

      const value = project()

      return value ? displayName(value) : language.t("sidebar.view.other")
    }

    // The project's copy on this group's server, or on the current server when the group spans several.
    const target = () => {
      const value = project()

      if (!value) return

      const copy = (conn: ServerConnection.Any) =>
        ctxOf(ServerConnection.key(conn))
          ?.projects.list()
          .find((item) => item.id === value.id)

      const owners = connected().filter((conn) => copy(conn))

      const server = group().server

      const conn = (server ? connOf(server) : undefined) ?? owners.find(servers.current) ?? owners[0]

      if (conn) return { conn, worktree: copy(conn)?.worktree ?? value.worktree }
    }

    const newSession = () => {
      const value = target()

      if (value) actions.openProjectNewSession(value.conn, value.worktree)
    }

    // Koma: the project's own settings, on the server a new session would start on.
    const openSettings = () => {
      const value = target()

      if (value) surface.openProject({ server: ServerConnection.key(value.conn), project: value.worktree })
    }

    // Koma: the row is the trigger of the project's context menu. Its children keep upstream's indentation.
    return (
      <Menu.Context modal={false}>
      <Menu.Context.Trigger
        as="div"
        data-slot="sidebar-project-row"
        class="group/sidebar-group relative flex min-w-0 shrink-0 items-center rounded-[6px] pe-1"
        classList={{
          "h-7 hover:bg-v2-overlay-simple-overlay-hover has-[:focus-visible]:bg-v2-overlay-simple-overlay-hover":
            !section(),
          "h-6 mt-2 first:mt-0": section(),
        }}
        data-sidebar-group={group().key}
      >
        <button
          type="button"
          class="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 rounded-[6px] bg-transparent px-2 text-start leading-[var(--line-height-compact)] focus-visible:outline-none"
          classList={{
            "text-[13px] text-v2-text-text-muted [font-weight:440] group-hover/sidebar-group:text-v2-text-text-base focus-visible:text-v2-text-text-base":
              !section(),
            "text-[12px] font-medium text-v2-text-text-faint hover:text-v2-text-text-muted focus-visible:text-v2-text-text-muted":
              section(),
          }}
          aria-expanded={!group().collapsed}
          onClick={() => setView("collapsed", group().key, !view.collapsed[group().key])}
        >
          <span class="flex size-4 shrink-0 items-center justify-center">
            <Show
              when={project()}
              fallback={
                <Icon
                  name={group().kind === "server" ? "server" : "outline-dots"}
                  class="text-v2-icon-icon-muted"
                />
              }
            >
              {(value) => <ProjectIcon project={value()} />}
            </Show>
          </span>
          <span class="min-w-0 flex-1 truncate" dir="auto">
            {label()}
          </span>
        </button>
        <span class="relative flex size-5 shrink-0 items-center justify-center">
          <Show when={group().collapsed && group().open > 0}>
            <span
              class="text-[11px] leading-[var(--line-height-compact)] text-v2-text-text-faint"
              classList={{
                "group-hover/sidebar-group:invisible group-has-[:focus-visible]/sidebar-group:invisible": !!project(),
              }}
            >
              {group().open}
            </span>
          </Show>
          <Show when={project()}>
            <span class="hover-reveal absolute inset-0 flex items-center justify-center group-hover/sidebar-group:opacity-100 focus-within:opacity-100">
              <IconButton
                icon={<Icon name="edit" />}
                variant="ghost-muted"
                size="small"
                aria-label={language.t("command.session.new")}
                onClick={newSession}
              />
            </span>
          </Show>
        </span>
      </Menu.Context.Trigger>
      <Show when={project()}>
        <Menu.Context.Portal>
          <Menu.Context.Content>
            <Menu.Item data-action="sidebar-project-new-session" onSelect={newSession}>
              {language.t("command.session.new")}
            </Menu.Item>
            <Menu.Item data-action="sidebar-project-settings" onSelect={openSettings}>
              {language.t("sidebar.project.settings")}
            </Menu.Item>
          </Menu.Context.Content>
        </Menu.Context.Portal>
      </Show>
      </Menu.Context>
    )
  }

  const toggleFilter = (kind: SidebarFilterKind, value: string, on: boolean) =>
    setLocal("filters", kind, (values: string[]) =>
      on ? [...new Set([...values, value])] : values.filter((item) => item !== value),
    )

  // Row status is only worked out when it changes the view, so read the unread state directly.
  const isUnread = (row: Row) =>
    !!row.session && !!ctxOf(row.server)?.notification.session.unread(row.session.id, row.session)

  const markAllRead = () =>
    visibleRows().forEach((row) => {
      if (row.session && isUnread(row)) ctxOf(row.server)?.notification.session.markViewed(row.session.id)
    })

  const anyUnread = () => visibleRows().some(isUnread)

  const filterCount = () => local.filters.status.length + local.filters.server.length + local.filters.project.length

  return (
    <div class="flex min-h-0 flex-1 flex-col [app-region:no-drag]">
      <label
        data-slot="sidebar-search"
        class="mb-2 flex h-7 shrink-0 items-center gap-2 rounded-[6px] px-2 text-v2-text-text-faint focus-within:bg-v2-overlay-simple-overlay-hover"
      >
        <Icon name="magnifying-glass" class="shrink-0" />
        <input
          type="search"
          data-action="sidebar-search"
          class="min-w-0 flex-1 bg-transparent text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint [&::-webkit-search-cancel-button]:hidden"
          placeholder={language.t("home.sessions.search.placeholder")}
          aria-label={language.t("home.sessions.search.placeholder")}
          value={search.input}
          onInput={(event) => typeSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !search.input) return
            event.stopPropagation()
            clearSearch()
          }}
        />
      </label>
      <div class="flex h-7 shrink-0 items-center gap-1.5 ps-2 pe-1">
        <span class="min-w-0 flex-1 truncate text-[13px] leading-[var(--line-height-compact)] font-medium text-v2-text-text-muted">
          {language.t("sidebar.view.sessions")}
        </span>
        <SidebarViewMenu
          state={state()}
          servers={serverOptions()}
          projects={projectOptions()}
          canMarkRead={anyUnread()}
          onGrouping={(value) => setView("grouping", value)}
          onOrdering={(value) => setView("ordering", value)}
          onShow={(key, value) => setView("show", key, value)}
          onFilter={toggleFilter}
          onResetFilters={() => setLocal("filters", { status: [], server: [], project: [] })}
          onMarkRead={markAllRead}
        />
        <IconButton
          icon={<Icon name="plus" />}
          variant="ghost-muted"
          size="small"
          aria-label={language.t("command.session.new")}
          onClick={props.onNewSession}
        />
      </div>
      <div class="flex min-h-0 flex-1 flex-col pt-1">
        {props.children({
          sections: sections(),
          tabFooter,
          tabLabel,
          tabMenu,
          leading: pinnedLeading(),
          hidden: pins.holds,
        })}
        <Show when={searching() && visibleRows().length === 0 && !searchQueries.some((query) => query.isFetching)}>
          <div class="px-2 py-2 text-12-regular text-v2-text-text-faint">
            {language.t("home.sessions.search.noResults", { query: search.query })}
          </div>
        </Show>
        <Show when={!searching() && filterCount() > 0 && !visibleRows().some((row) => !row.active)}>
          <div class="px-2 py-2 text-12-regular text-v2-text-text-faint">
            {language.t("sidebar.view.noMatch")}{" "}
            <button
              type="button"
              class="underline hover:text-v2-text-text-base"
              onClick={() => setLocal("filters", { status: [], server: [], project: [] })}
            >
              {language.t("sidebar.view.resetFilters")}
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}

/** Tracks session activity on every server, and keeps a preview tab once its session does something. */
function createSidebarActivityListener() {
  const tabs = useTabs()

  const global = useGlobal()

  // Keep a preview tab once its session shows activity. Ordering comes from the shared data layer, so this listener
  // only decides when a preview has become worth keeping.
  createEffect(() => {
    global.servers.list().forEach((conn) => {
      const server = ServerConnection.key(conn)
      const ctx = global.serverCtx(server)

      if (!ctx) return
      onCleanup(
        ctx.data.listen(({ details }) => {
          if (!isSidebarSessionActivity(details)) return
          const sessionID = details.data.sessionID
          const preview = tabs.preview()

          if (
            preview?.server === server &&
            (preview.sessionId === sessionID || preview.sessionId === ctx.data.session.root(sessionID))
          )
            tabs.keepPreview()
        }),
      )
    })
  })
}
