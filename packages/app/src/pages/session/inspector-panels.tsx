import { Message, Part, ToolRegistry, getToolInfo } from "@opencode-ai/session-ui/message-part"
import { DataProvider, useData } from "@opencode-ai/session-ui/context"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useParams } from "@solidjs/router"
import { createEffect, createMemo, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { normalizeSessionInfo } from "@/utils/session"
import {
  childSessionStatus,
  discoverChildSessions,
  inspectorTools,
  rawToolDetail,
  relatedChildSessions,
  taskSessionID,
  toolStatus,
  visibleMessage,
} from "./inspector-data"

const statusKey = {
  pending: "session.inspector.status.pending",
  running: "session.inspector.status.running",
  completed: "session.inspector.status.completed",
  error: "session.inspector.status.error",
  unknown: "session.inspector.status.unknown",
  idle: "session.inspector.status.idle",
  retry: "session.inspector.status.retry",
  archived: "session.inspector.status.archived",
} as const

function Status(props: { value: keyof typeof statusKey }) {
  const language = useLanguage()
  return (
    <span class="shrink-0 text-11-regular text-text-weak" data-slot="inspector-status" data-status={props.value}>
      {language.t(statusKey[props.value])}
    </span>
  )
}

function LoadEarlier(props: { sessionID: string }) {
  const language = useLanguage()
  const serverSync = useServerSync()
  const [state, setState] = createStore({ failed: false })
  let request = 0
  const load = () => {
    const current = ++request
    const id = props.sessionID
    const store = serverSync().session
    setState("failed", false)
    void store.history.loadMore(id).catch(() => {
      if (request === current && props.sessionID === id) setState("failed", true)
    })
  }
  createEffect(() => {
    props.sessionID
    serverSync().session
    request++
    setState("failed", false)
    onCleanup(() => {
      request++
    })
  })
  return (
    <div class="flex flex-col items-center gap-1">
      <Show when={state.failed}>
        <span class="text-11-regular text-text-critical">{language.t("session.inspector.loadFailed")}</span>
      </Show>
      <Show when={serverSync().session.history.more(props.sessionID)}>
        <Button
          variant="ghost"
          size="small"
          disabled={serverSync().session.history.loading(props.sessionID)}
          onClick={load}
        >
          <Show when={serverSync().session.history.loading(props.sessionID)} fallback={<Icon name="arrow-up" />}>
            <Spinner />
          </Show>
          {language.t(
            state.failed
              ? "session.inspector.retry"
              : serverSync().session.history.loading(props.sessionID)
                ? "session.inspector.loadingEarlier"
                : "session.inspector.loadEarlier",
          )}
        </Button>
      </Show>
    </div>
  )
}

export function BackgroundTasksPanel(props: { onTool: (part: ToolPart) => void; onSession: (id: string) => void }) {
  const params = useParams()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [state, setState] = createStore({ loading: true, failed: false, discovering: true, discoveryFailed: false })
  let request = 0
  let discoveryRequest = 0
  let discoveryController: AbortController | undefined
  const routeSessionID = () => params.id ?? ""
  const sessionID = () => serverSync().session.lineage.peek(routeSessionID())?.root.id ?? routeSessionID()
  const directory = createMemo(() => serverSync().session.get(sessionID())?.directory)
  const tools = createMemo(() =>
    inspectorTools(serverSync().session.data.message[sessionID()] ?? [], serverSync().session.data.part),
  )
  const children = createMemo(() => relatedChildSessions(sessionID(), serverSync().session.data.info, tools()))
  const referenced = createMemo(() => [...new Set(tools().flatMap((item) => taskSessionID(item.part) ?? []))])
  const childRows = createMemo(() => {
    const known = children().map((session) => ({ id: session.id, session }))
    const ids = new Set(known.map((item) => item.id))
    return [
      ...known,
      ...referenced()
        .filter((id) => !ids.has(id))
        .map((id) => ({ id, session: undefined })),
    ]
  })

  const load = (store = serverSync().session) => {
    const id = sessionID()
    const current = ++request
    if (!id) {
      setState({ loading: false, failed: true })
      return
    }
    setState({ loading: true, failed: false })
    void store.sync(id).then(
      () => {
        if (request === current && sessionID() === id) setState("loading", false)
      },
      () => {
        if (request === current && sessionID() === id) setState({ loading: false, failed: true })
      },
    )
  }

  const discover = (store = serverSync().session, sdk = serverSDK()) => {
    const rootID = sessionID()
    const directory = store.get(rootID)?.directory
    const current = ++discoveryRequest
    discoveryController?.abort()
    const controller = new AbortController()
    discoveryController = controller
    setState({ discovering: true, discoveryFailed: false })
    if (!rootID || !directory) {
      setState({ discovering: false, discoveryFailed: true })
      return controller
    }
    void discoverChildSessions({
      rootID,
      protocol: sdk.protocol,
      signal: controller.signal,
      children: (parentID, signal) =>
        sdk.client.session.children({ sessionID: parentID, directory }, { signal }).then((result) => result.data ?? []),
      list: (cursor, signal) =>
        sdk.api.session.list({ directory, limit: 100, order: "desc", cursor }, { signal }).then((result) => ({
          data: result.data.map(normalizeSessionInfo),
          cursor: result.cursor.next ?? undefined,
        })),
    })
      .then((sessions) => {
        if (discoveryRequest !== current || controller.signal.aborted) return []
        return Promise.all(sessions.map((session) => store.resolve(session.id)))
      })
      .then(
        () => {
          if (discoveryRequest !== current || controller.signal.aborted) return
          setState("discovering", false)
        },
        () => {
          if (discoveryRequest !== current || controller.signal.aborted) return
          setState({ discovering: false, discoveryFailed: true })
        },
      )
    return controller
  }

  createEffect(
    on([sessionID, directory, () => serverSync().session, serverSDK], () => {
      const store = serverSync().session
      const sdk = serverSDK()
      load(store)
      discover(store, sdk)
      onCleanup(() => {
        request++
        discoveryRequest++
        discoveryController?.abort()
      })
    }),
  )

  createEffect(() => {
    const store = serverSync().session
    for (const id of referenced()) {
      if (store.get(id)) continue
      void store.resolve(id).catch(() => {})
    }
  })

  return (
    <div class="h-full overflow-y-auto px-3 py-3" data-component="background-tasks-panel">
      <Show
        when={!state.failed && !state.discoveryFailed}
        fallback={
          <div class="flex min-h-32 flex-col items-center justify-center gap-2">
            <Empty label={language.t("session.inspector.loadFailed")} />
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                load()
                discover()
              }}
            >
              {language.t("session.inspector.retry")}
            </Button>
          </div>
        }
      >
        <Show
          when={(!state.loading && !state.discovering) || tools().length > 0 || childRows().length > 0}
          fallback={<PanelState loading label="" />}
        >
          <Show
            when={tools().length > 0 || childRows().length > 0}
            fallback={<Empty label={language.t("session.inspector.background.empty")} />}
          >
            <Show when={tools().length > 0}>
              <section class="mb-5">
                <h3 class="mb-2 text-11-medium uppercase text-text-weak">{language.t("session.inspector.tools")}</h3>
                <div class="flex flex-col gap-1">
                  <For each={tools()}>
                    {(item) => (
                      <button
                        type="button"
                        data-slot="inspector-tool-row"
                        class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-base-hover"
                        onClick={() => props.onTool(item.part)}
                      >
                        <Icon name={item.part.tool === "task" ? "subagent" : "console"} size="small" />
                        <span class="min-w-0 flex-1 text-12-regular text-text-base">
                          <span class="block truncate">{item.part.tool}</span>
                          <span class="block truncate text-11-regular text-text-weak">
                            {
                              getToolInfo(
                                item.part.tool,
                                item.part.state.input,
                                "metadata" in item.part.state ? item.part.state.metadata : undefined,
                              ).subtitle
                            }
                          </span>
                        </span>
                        <Status value={toolStatus(item.part)} />
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>
            <Show when={childRows().length > 0}>
              <section>
                <h3 class="mb-2 text-11-medium uppercase text-text-weak">
                  {language.t("session.inspector.subagents")}
                </h3>
                <div class="flex flex-col gap-1">
                  <For each={childRows()}>
                    {(item) => (
                      <button
                        type="button"
                        data-slot="inspector-child-row"
                        class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-base-hover"
                        onClick={() => props.onSession(item.id)}
                      >
                        <Icon name="subagent" size="small" />
                        <span class="min-w-0 flex-1 truncate text-12-regular text-text-base">
                          {item.session?.title ?? item.id}
                        </span>
                        <Status
                          value={
                            item.session
                              ? childSessionStatus(item.session, serverSync().session.data.session_status[item.id])
                              : "unknown"
                          }
                        />
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </Show>
        </Show>
      </Show>
      <div class="mt-3 flex justify-center">
        <LoadEarlier sessionID={sessionID()} />
      </div>
    </div>
  )
}

export function ToolInspectorPanel(props: { sessionID: string; messageID: string; partID: string }) {
  const language = useLanguage()
  const data = useData()
  const serverSync = useServerSync()
  const [state, setState] = createStore({ loading: true, loadFailed: false, missing: false })
  let loadRequest = 0
  const message = createMemo(() =>
    (serverSync().session.data.message[props.sessionID] ?? []).find((item) => item.id === props.messageID),
  )
  const part = createMemo(() =>
    (serverSync().session.data.part[props.messageID] ?? []).find(
      (item): item is ToolPart => item.id === props.partID && item.type === "tool",
    ),
  )

  createEffect(() => {
    const id = props.sessionID
    const session = serverSync().session
    session.pin(id)
    onCleanup(() => session.unpin(id))
  })

  const load = (session = serverSync().session) => {
    const current = ++loadRequest
    const target = `${props.sessionID}:${props.messageID}:${props.partID}`
    setState({ loading: true, loadFailed: false, missing: false })
    session.sync(props.sessionID).then(
      () => {
        if (loadRequest === current && target === `${props.sessionID}:${props.messageID}:${props.partID}`)
          setState("loading", false)
      },
      () => {
        if (loadRequest === current && target === `${props.sessionID}:${props.messageID}:${props.partID}`)
          setState({ loading: false, loadFailed: true })
      },
    )
  }

  createEffect(() => {
    props.sessionID
    props.messageID
    props.partID
    const session = serverSync().session
    load(session)
    onCleanup(() => {
      loadRequest++
    })
  })

  createEffect(() => {
    if (part() || state.loadFailed || state.missing || state.loading) return
    if (serverSync().session.history.loading(props.sessionID)) return
    if (!serverSync().session.history.more(props.sessionID)) {
      setState("missing", true)
      return
    }
    const session = serverSync().session
    const current = loadRequest
    const target = `${props.sessionID}:${props.messageID}:${props.partID}`
    void session.history.loadMore(props.sessionID).catch(() => {
      if (loadRequest === current && target === `${props.sessionID}:${props.messageID}:${props.partID}`)
        setState("loadFailed", true)
    })
  })

  const searching = createMemo(
    () =>
      state.loading ||
      serverSync().session.history.loading(props.sessionID) ||
      (!part() && !state.loadFailed && !state.missing && serverSync().session.history.more(props.sessionID)),
  )

  const fallback = createMemo(() => {
    const item = part()
    return item ? rawToolDetail(item, !!ToolRegistry.render(item.tool)) : undefined
  })

  return (
    <DataProvider
      data={data.store}
      directory={serverSync().session.get(props.sessionID)?.directory ?? data.directory}
      sessionID={props.sessionID}
      onSessionHref={data.sessionHref}
    >
      <div class="h-full overflow-y-auto p-3" data-component="tool-inspector-panel">
        <Show
          when={message() && part()}
          fallback={
            <Show
              when={!state.loadFailed}
              fallback={
                <div class="flex min-h-32 flex-col items-center justify-center gap-2">
                  <PanelState loading={false} label={language.t("session.inspector.loadFailed")} />
                  <Button variant="ghost" size="small" onClick={() => load()}>
                    {language.t("session.inspector.retry")}
                  </Button>
                </div>
              }
            >
              <PanelState loading={searching()} label={language.t("session.inspector.missingTool")} />
            </Show>
          }
        >
          <Part
            part={part()!}
            message={message()!}
            defaultOpen
            toolOpen
            deferToolContent={false}
            virtualizeDiff={false}
          />
          <Show when={fallback()}>
            {(detail) => (
              <section class="mt-3">
                <h3 class="mb-2 text-11-medium uppercase text-text-weak">
                  {language.t(detail().type === "input" ? "session.inspector.input" : "session.inspector.output")}
                </h3>
                <pre class="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-base px-3 py-2 text-12-regular text-text-base">
                  {detail().text}
                </pre>
              </section>
            )}
          </Show>
        </Show>
      </div>
    </DataProvider>
  )
}

export function ChildSessionPanel(props: {
  sessionID: string
  onTool: (part: ToolPart) => void
  onSession: (id: string) => void
}) {
  const language = useLanguage()
  const data = useData()
  const serverSync = useServerSync()
  const [state, setState] = createStore({ loading: true, failed: false })
  let loadRequest = 0
  const session = createMemo(() => serverSync().session.get(props.sessionID))
  const messages = createMemo(() =>
    (serverSync().session.data.message[props.sessionID] ?? []).filter((message) =>
      visibleMessage(message, serverSync().session.data.part[message.id] ?? []),
    ),
  )

  onMount(() => {
    const targetSessionID = props.sessionID
    console.info("[subagent-navigation]", JSON.stringify({ phase: "mounted", targetSessionID }))
    onCleanup(() => {
      console.info("[subagent-navigation]", JSON.stringify({ phase: "unmounted", targetSessionID }))
    })
  })

  createEffect(() => {
    const id = props.sessionID
    const store = serverSync().session
    store.pin(id)
    onCleanup(() => store.unpin(id))
  })

  const load = (store = serverSync().session) => {
    const current = ++loadRequest
    const id = props.sessionID
    setState({ loading: true, failed: false })
    Promise.all([store.resolve(id), store.sync(id)]).then(
      () => {
        if (loadRequest !== current || props.sessionID !== id) return
        setState("loading", false)
        console.info(
          "[subagent-navigation]",
          JSON.stringify({
            phase: "loaded",
            targetSessionID: id,
            found: !!store.get(id),
            messages: (store.data.message[id] ?? []).length,
          }),
        )
      },
      () => {
        if (loadRequest !== current || props.sessionID !== id) return
        setState({ loading: false, failed: true })
        console.info("[subagent-navigation]", JSON.stringify({ phase: "load-failed", targetSessionID: id }))
      },
    )
  }

  createEffect(() => {
    props.sessionID
    const store = serverSync().session
    load(store)
    onCleanup(() => {
      loadRequest++
    })
  })

  const href = createMemo(() => data.sessionHref?.(props.sessionID))

  return (
    <DataProvider
      data={data.store}
      directory={session()?.directory ?? data.directory}
      sessionID={props.sessionID}
      onNavigateToSession={props.onSession}
      onSessionHref={data.sessionHref}
    >
      <div class="flex h-full min-h-0 flex-col" data-component="child-session-panel">
        <Show when={session()}>
          {(item) => (
            <header class="flex items-center gap-2 border-b border-border-weak-base px-3 py-2">
              <span class="min-w-0 flex-1 truncate text-12-medium text-text-base">{item().title}</span>
              <Status value={childSessionStatus(item(), serverSync().session.data.session_status[props.sessionID])} />
              <Show when={href()}>
                {(url) => (
                  <a class="text-11-medium text-text-interactive hover:underline" href={url()}>
                    {language.t("session.inspector.openFullTask")}
                  </a>
                )}
              </Show>
            </header>
          )}
        </Show>
        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <Show
            when={!state.failed}
            fallback={
              <div class="flex min-h-32 flex-col items-center justify-center gap-2">
                <Empty label={language.t("session.inspector.loadFailed")} />
                <Button variant="ghost" size="small" onClick={() => load()}>
                  {language.t("session.inspector.retry")}
                </Button>
              </div>
            }
          >
            <Show
              when={!state.loading || messages().length > 0}
              fallback={<PanelState loading label={language.t("session.inspector.missingSession")} />}
            >
              <For each={messages()}>
                {(message) => (
                  <div class="mb-4" data-inspector-message-id={message.id}>
                    <Message
                      message={message}
                      parts={serverSync().session.data.part[message.id] ?? []}
                      onInspectTool={props.onTool}
                      onPreviewSession={props.onSession}
                    />
                  </div>
                )}
              </For>
              <Show when={!state.loading && messages().length === 0}>
                <Empty label={language.t("session.inspector.child.empty")} />
              </Show>
              <div class="flex justify-center">
                <LoadEarlier sessionID={props.sessionID} />
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </DataProvider>
  )
}

function PanelState(props: { loading: boolean; label: string }) {
  return (
    <div class="flex h-full min-h-32 items-center justify-center gap-2 text-12-regular text-text-weak">
      <Show when={props.loading}>
        <Spinner />
      </Show>
      <Show when={!props.loading}>{props.label}</Show>
    </div>
  )
}

function Empty(props: { label: string }) {
  return (
    <div class="flex min-h-32 items-center justify-center px-4 text-center text-12-regular text-text-weak">
      {props.label}
    </div>
  )
}
