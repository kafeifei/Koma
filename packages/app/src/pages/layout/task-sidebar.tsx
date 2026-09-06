import { createMemo, createResource, For, Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useCommand } from "@/context/command"
import { useGlobal, type ServerCtx } from "@/context/global"
import { createHomeSessionQuery } from "@/context/global-sync/home-session-query"
import { useLanguage } from "@/context/language"
import { useLayout, type LocalProject } from "@/context/layout"
import { ServerConnection, serverName } from "@/context/server"
import { tabHref, useTabs } from "@/context/tabs"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeProjectsController } from "@/pages/home/home-projects-controller"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import { displayName } from "./helpers"
import { useSessionTabAvatarState } from "./project-avatar-state"
import {
  filterClosedSessionDirectories,
  taskProjectGroups,
  taskSessionProjectDirectory,
  visibleTaskSessions,
} from "./task-sidebar-data"
import { TaskSidebarMenu } from "./task-sidebar-menu"
import { createTaskSearch } from "./task-search"
import { pathKey } from "@/utils/path-key"
import { BuildInfo } from "@/components/build-info"
import { sessionCapabilities } from "@/utils/server-compat"
import { mutateTask, type TaskLifecycleOperation } from "./task-lifecycle"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogWorktreeManager } from "@/components/dialog-worktree-manager"
import "./task-sidebar.css"

export function TaskSidebar(props: ParentProps<{ opened: boolean; onNavigate: () => void }>) {
  const global = useGlobal()
  const layout = useLayout()
  const command = useCommand()
  const navigate = useNavigate()
  const language = useLanguage()
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const [state, setState] = createStore({ search: "", archived: false })
  const focusedServer = createMemo(() => {
    const route = layout.route()
    const key = route.type === "session" || route.type === "draft" ? route.server : home.selection.value().server
    return global.servers.list().find((conn) => ServerConnection.key(conn) === key) ?? home.server.focused()
  })
  const chooseProject = () => {
    const conn = focusedServer()
    if (conn) projects.project.choose(conn)
  }

  return (
    <aside
      id="task-sidebar"
      data-component="task-sidebar"
      hidden={!props.opened}
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
    >
      <div data-slot="workspace-actions">
        <button
          type="button"
          data-action="workspace-new-task"
          data-slot="workspace-action"
          onClick={() => {
            if (!global.servers.list().some((conn) => global.ensureServerCtx(conn).projects.list().length)) {
              chooseProject()
              return
            }
            command.trigger("tab.new")
            props.onNavigate()
          }}
        >
          <Icon name="edit" />
          <span>{language.t("workspace.newTask")}</span>
        </button>
        <button
          type="button"
          data-slot="workspace-action"
          aria-current={layout.route().type === "home" ? "page" : undefined}
          onClick={() => {
            const conn = focusedServer()
            if (conn) home.selection.set({ server: ServerConnection.key(conn) })
            navigate("/")
            props.onNavigate()
          }}
        >
          <Icon name="grid-plus" />
          <span>{language.t("home.title")}</span>
        </button>
        <label data-slot="workspace-search">
          <Icon name="magnifying-glass" />
          <input
            type="search"
            aria-label={language.t("workspace.search.placeholder")}
            placeholder={language.t("workspace.search.placeholder")}
            value={state.search}
            onInput={(event) => setState("search", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setState("search", "")
            }}
          />
        </label>
      </div>
      <nav data-slot="workspace-task-list" aria-label={language.t("sidebar.nav.projectsAndSessions")}>
        <For each={global.servers.list()}>
          {(conn) => (
            <Suspense fallback={<div data-slot="workspace-empty">{language.t("common.loading")}</div>}>
              <TaskServer
                conn={conn}
                query={state.search}
                archived={state.archived}
                showServer={global.servers.list().length > 1}
                onNavigate={props.onNavigate}
                onNewTask={(project) => {
                  home.project.openProjectNewSession(conn, project.worktree)
                  props.onNavigate()
                }}
                onChooseProject={() => projects.project.choose(conn)}
              />
            </Suspense>
          )}
        </For>
      </nav>
      <div data-slot="workspace-footer">
        <button
          type="button"
          data-slot="workspace-action"
          data-action="workspace-archives"
          aria-pressed={state.archived}
          onClick={() => setState("archived", !state.archived)}
        >
          <Icon name={state.archived ? "arrow-left" : "archive"} />
          <span>{language.t(state.archived ? "workspace.activeTasks" : "workspace.archived")}</span>
        </button>
        <button type="button" data-slot="workspace-action" onClick={projects.utility.settings}>
          <Icon name="settings-gear" />
          <span>{language.t("sidebar.settings")}</span>
        </button>
        <BuildInfo />
      </div>
      {props.children}
    </aside>
  )
}

function TaskServer(props: {
  conn: ServerConnection.Any
  query: string
  archived: boolean
  showServer: boolean
  onNavigate: () => void
  onNewTask: (project: LocalProject) => void
  onChooseProject: () => void
}) {
  const global = useGlobal()
  const layout = useLayout()
  const language = useLanguage()
  const context = createMemo(() => global.ensureServerCtx(props.conn))
  const key = () => ServerConnection.key(props.conn)
  const sessions = createHomeSessionQuery(context)
  const search = createTaskSearch({ context, query: () => props.query, archived: () => props.archived })
  const snippets = createMemo(() => new Map(search.hits().map((hit) => [hit.sessionID, hit.snippet])))
  const activeSessionDirectory = createMemo(() => {
    const route = layout.route()
    if (route.type !== "session" || route.server !== key()) return
    const lineage = context().sync.session.lineage.peek(route.sessionId)
    const info = context().sync.session.get(route.sessionId)
    const directory = lineage?.root.directory ?? info?.directory
    if (!directory) return
    return taskSessionProjectDirectory(
      { directory, projectID: info?.projectID ?? "global" },
      context().sync.data.project,
    )
  })
  const activeID = createMemo(() => {
    const route = layout.route()
    if (route.type !== "session" || route.server !== key()) return
    return context().sync.session.lineage.peek(route.sessionId)?.root.id ?? route.sessionId
  })
  const projects = createMemo(() => {
    const opened = context().projects.list()
    if (!props.archived && !props.query.trim()) return opened
    const directories = filterClosedSessionDirectories(
      (props.archived ? sessions.archived() : sessions.sessions()).map((session) =>
        taskSessionProjectDirectory(session, context().sync.data.project),
      ),
      context()
        .projects.recentlyClosed()
        .map((project) => project.worktree),
      context().sync.data.project,
    )
    return [
      ...opened,
      ...[...new Set(directories)]
        .filter(
          (directory) =>
            !opened.some(
              (project) =>
                pathKey(project.worktree) === pathKey(directory) ||
                project.sandboxes?.some((sandbox) => pathKey(sandbox) === pathKey(directory)),
            ),
        )
        .map((directory) => ({
          ...context().sync.data.project.find((project) => project.worktree === directory),
          worktree: directory,
          expanded: true,
        })),
    ]
  })
  const groups = createMemo(() =>
    taskProjectGroups(projects(), props.archived ? sessions.archived() : sessions.sessions(), props.query, {
      archived: props.archived,
      pinned: context().tasks.pinned(),
      matches: [...snippets().keys()],
    }).filter((group) => !props.archived || group.sessions.length > 0),
  )

  return (
    <section data-slot="workspace-server" data-server-key={key()}>
      <Show when={props.showServer}>
        <div data-slot="workspace-section-heading">{serverName(props.conn)}</div>
      </Show>
      <div data-slot="workspace-section-heading">
        <span>{language.t(props.archived ? "workspace.archived" : "home.projects")}</span>
        <button
          type="button"
          data-slot="workspace-icon-action"
          onClick={props.onChooseProject}
          aria-label={language.t("home.project.add")}
        >
          <Icon name="plus" />
        </button>
      </div>
      <Show when={sessions.error()}>
        <div data-slot="workspace-empty" role="alert">
          {language.t("common.requestFailed")}
          <button type="button" data-slot="workspace-action" onClick={() => void sessions.refetch()}>
            {language.t("workspace.retry")}
          </button>
        </div>
      </Show>
      <Show when={sessions.loading()}>
        <div data-slot="workspace-empty" role="status">
          {language.t("common.loading")}
        </div>
      </Show>
      <Show when={search.loading()}>
        <div data-slot="workspace-empty" role="status">
          {language.t("workspace.search.loading")}
        </div>
      </Show>
      <Show when={search.error()}>
        <div data-slot="workspace-empty" role="alert">
          {language.t("workspace.search.failed")}
          <button type="button" data-slot="workspace-action" onClick={() => void search.retry()}>
            {language.t("workspace.retry")}
          </button>
        </div>
      </Show>
      <For each={groups().map((group) => group.project.worktree)}>
        {(directory) => {
          const group = createMemo<ReturnType<typeof groups>[number]>(
            (previous) => groups().find((item) => item.project.worktree === directory) ?? previous,
            groups().find((item) => item.project.worktree === directory)!,
          )
          return (
            <TaskProject
              project={group().project}
              sessions={group().sessions}
              context={context()}
              server={key()}
              activeID={activeID()}
              activeProject={(() => {
                const directory = activeSessionDirectory()
                return (
                  directory !== undefined &&
                  (pathKey(group().project.worktree) === pathKey(directory) ||
                    group().project.sandboxes?.some((sandbox) => pathKey(sandbox) === pathKey(directory)) === true)
                )
              })()}
              searching={!!props.query.trim()}
              archived={props.archived}
              snippets={snippets()}
              onNavigate={props.onNavigate}
              onNewTask={() => props.onNewTask(group().project)}
            />
          )
        }}
      </For>
      <Show when={search.more()}>
        <button
          type="button"
          data-action="workspace-search-more"
          data-slot="workspace-show-more"
          disabled={search.loading()}
          onClick={() => void search.next()}
        >
          {language.t("workspace.search.more")}
        </button>
      </Show>
      <Show
        when={!sessions.loading() && !sessions.error() && !search.loading() && !search.error() && groups().length === 0}
      >
        <div data-slot="workspace-empty">
          {props.query.trim()
            ? language.t("home.sessions.search.noResults", { query: props.query })
            : language.t(props.archived ? "workspace.archive.empty" : "sidebar.empty.description")}
        </div>
      </Show>
    </section>
  )
}

function TaskProject(props: {
  project: LocalProject
  sessions: Session[]
  context: ServerCtx
  server: ServerConnection.Key
  activeID?: string
  activeProject: boolean
  searching: boolean
  archived: boolean
  snippets: Map<string, string>
  onNavigate: () => void
  onNewTask: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [state, setState] = createStore({ collapsed: false, limit: 8 })
  const open = () => props.searching || !state.collapsed
  const visible = createMemo(() => visibleTaskSessions(props.sessions, state.limit, props.activeID))
  const remove = () => {
    if (props.activeProject) navigate("/")
    props.context.projects.close(props.project.worktree)
  }
  return (
    <section data-slot="workspace-project" data-directory={props.project.worktree}>
      <div data-slot="workspace-project-heading">
        <button
          type="button"
          data-slot="workspace-action"
          aria-expanded={open()}
          onClick={() => setState("collapsed", !state.collapsed)}
          title={props.project.worktree}
        >
          <Icon name="chevron-down" class={open() ? "" : "-rotate-90"} />
          <Icon name="folder" />
          <span>{displayName(props.project)}</span>
        </button>
        <Show when={!props.archived}>
          <button
            type="button"
            data-slot="workspace-icon-action"
            aria-label={language.t("workspace.newTask")}
            onClick={props.onNewTask}
          >
            <Icon name="plus" />
          </button>
        </Show>
        <DropdownMenu placement="bottom-end" gutter={4}>
          <DropdownMenu.Trigger
            as="button"
            type="button"
            data-action="project-remove"
            aria-label={language.t("workspace.removeProject")}
            title={language.t("workspace.removeProject")}
          >
            …
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <Show when={props.project.vcs === "git"}>
                <DropdownMenu.Item
                  onSelect={() =>
                    dialog.show(() => (
                      <DialogWorktreeManager
                        root={props.project.worktree}
                        server={props.server}
                        context={props.context}
                        onNavigate={props.onNavigate}
                      />
                    ))
                  }
                >
                  <DropdownMenu.ItemLabel>{language.t("worktree.manager.title")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Item onSelect={remove}>
                <DropdownMenu.ItemLabel>{language.t("workspace.removeProject")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
      <div hidden={!open()}>
        <For each={visible().map((session) => session.id)}>
          {(id) => {
            // Keep the last summary until keyed disposal finishes when a mutation removes this row.
            const session = createMemo<Session>(
              (previous) => visible().find((session) => session.id === id) ?? previous,
              visible().find((session) => session.id === id)!,
            )
            return (
              <TaskSession
                session={session()}
                context={props.context}
                projectDirectory={props.project.worktree}
                server={props.server}
                active={id === props.activeID}
                archived={props.archived}
                snippet={props.snippets.get(id)}
                onNavigate={props.onNavigate}
              />
            )
          }}
        </For>
        <Show when={props.sessions.length === 0}>
          <div data-slot="workspace-empty">{language.t("home.sessions.empty")}</div>
        </Show>
        <Show when={visible().length < props.sessions.length}>
          <button
            type="button"
            data-slot="workspace-show-more"
            onClick={() => setState("limit", (limit) => limit + 20)}
          >
            {language.t("ui.common.showMore")}
          </button>
        </Show>
      </div>
    </section>
  )
}

function TaskSession(props: {
  session: Session
  context: ServerCtx
  projectDirectory: string
  server: ServerConnection.Key
  active: boolean
  archived: boolean
  snippet?: string
  onNavigate: () => void
}) {
  const tabs = useTabs()
  const navigate = useNavigate()
  const language = useLanguage()
  const [mutation, setMutation] = createStore({ pending: false })
  const [capabilities, capabilitiesAction] = createResource(
    () => props.context.sdk.api,
    (api) => sessionCapabilities(api).catch(() => undefined),
  )
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.session.directory,
    () => props.session.id,
  )
  const status = () =>
    state.needsAttention() ? "attention" : state.loading() ? "running" : state.unread() ? "unread" : "idle"
  const title = () => sessionTitle(props.session.title) || language.t("workspace.newTask")
  const tab = () => ({ type: "session" as const, server: props.server, sessionId: props.session.id })
  const lifecycle = async (operation: TaskLifecycleOperation) => {
    if (mutation.pending) return
    setMutation("pending", true)
    await mutateTask({
      context: props.context,
      tabs,
      server: props.server,
      projectDirectory: props.projectDirectory,
      session: props.session,
      operation,
      onArchivedOrDeleted: () => {
        if (props.active) navigate("/")
      },
    }).finally(() => setMutation("pending", false))
  }
  return (
    <TaskSidebarMenu
      title={title()}
      pinned={props.context.tasks.pinned().includes(props.session.id)}
      archived={props.archived}
      busy={mutation.pending}
      running={state.loading()}
      cleanupStatus={async () => {
        const result = await props.context.sdk.client.worktree.status({
          sessionID: props.session.id,
          directory: props.projectDirectory,
        })
        return result.data!
      }}
      onDelete={() => lifecycle("delete")}
      canMutate={!!capabilities()?.archive && !!capabilities()?.restore && !!capabilities()?.delete}
      onRetryCapabilities={() => void capabilitiesAction.refetch()}
      onPin={() => props.context.tasks.togglePin(props.session.id)}
      onRename={async (title) => {
        const context = props.context
        const target = tab()
        const info = { ...props.session, title }
        await context.sdk.api.session.rename({ sessionID: info.id, title })
        context.sync.homeSessions.apply({ type: "session.updated", properties: { sessionID: info.id, info } })
        void context.queryClient.invalidateQueries({ queryKey: ["task-search", context.sdk.scope] })
        tabs.rememberSessionInfo(target, info)
      }}
      onArchive={() => lifecycle("archive")}
      onRestore={() => lifecycle("restore")}
    >
      <a
        href={tabHref(tab())}
        data-slot="workspace-task"
        data-session-id={props.session.id}
        data-status={status()}
        aria-current={props.active ? "page" : undefined}
        title={title()}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          event.preventDefault()
          props.context.projects.open(props.projectDirectory)
          props.context.projects.touch(props.projectDirectory)
          const next = tabs.addSessionTab(tab())
          tabs.rememberSessionInfo(tab(), props.session)
          tabs.select(next)
          props.onNavigate()
        }}
      >
        <span
          data-slot="workspace-task-status"
          role="img"
          aria-label={language.t(`workspace.status.${status()}`)}
          title={language.t(`workspace.status.${status()}`)}
        >
          <Show when={state.loading()} fallback={<span data-slot="workspace-status-dot" />}>
            <Spinner />
          </Show>
        </span>
        <span data-slot="workspace-task-content">
          <span data-slot="workspace-task-title">{title()}</span>
          <Show when={props.snippet}>
            <span data-slot="workspace-task-snippet" title={props.snippet}>
              {props.snippet}
            </span>
          </Show>
        </span>
        <Show when={props.context.tasks.pinned().includes(props.session.id)}>
          <span data-slot="workspace-task-pin" title={language.t("workspace.task.unpin")}>
            <Icon name="pin" />
          </span>
        </Show>
        <Show when={!props.snippet}>
          <span data-slot="workspace-task-time">
            {getRelativeTime(
              new Date(props.session.time.updated ?? props.session.time.created).toISOString(),
              language.t,
            )}
          </span>
        </Show>
      </a>
    </TaskSidebarMenu>
  )
}
