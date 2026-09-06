import { createEffect, createMemo, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import type { ServerCtx } from "@/context/global"
import type { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { errorMessage } from "@/pages/layout/helpers"
import { mutateTask, type TaskLifecycleOperation } from "@/pages/layout/task-lifecycle"
import type {
  WorktreeDetailsResponse,
  WorktreeManagedResponse,
  WorktreeMergePreviewResponse,
} from "@opencode-ai/sdk/v2/client"
import "./dialog-worktree-manager.css"

type Entry = WorktreeManagedResponse[number]
type MergePreview = WorktreeMergePreviewResponse
type LoadResult<T> = { data: T; error?: undefined } | { data?: undefined; error: string }
type ResolutionChoice = "source" | "target"

export function DialogWorktreeManager(props: {
  root: string
  server: ServerConnection.Key
  context: ServerCtx
  onNavigate: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const tabs = useTabs()
  const layout = useLayout()
  const navigate = useNavigate()
  const [state, setState] = createStore({
    selected: "",
    confirm: undefined as "adopt" | "cleanup" | undefined,
    pending: undefined as "adopt" | "cleanup" | "preview" | "apply" | undefined,
    operationError: "",
    mergeError: "",
    applied: false,
    previewStale: false,
    deleteSession: "",
    sessionPending: "",
    resolutions: {} as Record<string, ResolutionChoice>,
    preview: undefined as MergePreview | undefined,
  })
  const [entries, entriesAction] = createResource<LoadResult<WorktreeManagedResponse>>(() =>
    props.context.sdk.client.worktree
      .managed({ directory: props.root }, { throwOnError: true })
      .then((result) => ({ data: result.data }))
      .catch((cause) => ({ error: errorMessage(cause, language.t("worktree.manager.loadFailed")) })),
  )
  const entryList = () => entries()?.data
  const entriesError = () => entries()?.error
  const selected = createMemo(() => entryList()?.find((entry) => entry.directory === state.selected))
  const [details, detailsAction] = createResource(
    () => {
      const entry = selected()
      if (!entry || entry.missing) return
      return entry.directory
    },
    (directory): Promise<LoadResult<WorktreeDetailsResponse>> =>
      props.context.sdk.client.worktree
        .details({ query_directory: props.root, body_directory: directory }, { throwOnError: true })
        .then((result) => ({ data: result.data }))
        .catch((cause) => ({ error: errorMessage(cause, language.t("worktree.manager.loadFailed")) })),
  )
  const detailValue = () => details()?.data
  const detailsError = () => details()?.error

  createEffect(() => {
    const list = entryList()
    if (!list?.length) return
    if (list.some((entry) => entry.directory === state.selected)) return
    setState("selected", (list.find((entry) => !entry.primary) ?? list[0]).directory)
  })

  const select = (directory: string) => {
    setState({
      selected: directory,
      confirm: undefined,
      operationError: "",
      mergeError: "",
      preview: undefined,
      applied: false,
      previewStale: false,
      deleteSession: "",
      resolutions: {},
    })
  }
  const refresh = async () => {
    setState({
      confirm: undefined,
      operationError: "",
      mergeError: "",
      preview: undefined,
      applied: false,
      previewStale: false,
      resolutions: {},
    })
    await entriesAction.refetch()
    await detailsAction.refetch()
  }
  const openDirectory = async () => {
    const entry = selected()
    if (!entry || entry.missing) return
    dialog.close()
    await tabs.newDraft({ server: props.server, directory: entry.directory })
    props.context.projects.open(entry.directory)
    props.onNavigate()
  }
  const openSession = (sessionID: string) => {
    const tab = tabs.addSessionTab({ server: props.server, sessionId: sessionID })
    tabs.select(tab)
    dialog.close()
    props.onNavigate()
  }
  const mutateSession = async (session: Entry["sessions"][number], operation: TaskLifecycleOperation) => {
    if (state.sessionPending) return
    setState({ sessionPending: session.id, operationError: "" })
    await mutateTask({
      context: props.context,
      tabs,
      server: props.server,
      projectDirectory: session.directory,
      sessionID: session.id,
      operation,
      onArchivedOrDeleted: () => {
        const route = layout.route()
        if (route.type === "session" && route.server === props.server && route.sessionId === session.id) navigate("/")
      },
    })
      .then(() => refresh())
      .catch((cause) => setState("operationError", errorMessage(cause, language.t("worktree.manager.operationFailed"))))
      .finally(() => setState({ sessionPending: "", deleteSession: "" }))
  }
  const adopt = async () => {
    const entry = selected()
    if (!entry || !entry.canAdopt) return
    setState({ pending: "adopt", operationError: "" })
    await props.context.sdk.client.worktree
      .adopt({ query_directory: props.root, body_directory: entry.directory }, { throwOnError: true })
      .then(() => refresh())
      .catch((cause) => setState("operationError", errorMessage(cause, language.t("worktree.manager.operationFailed"))))
      .finally(() => setState({ pending: undefined, confirm: undefined }))
  }
  const cleanup = async () => {
    const entry = selected()
    if (!entry?.orphan || entry.primary || entry.sessions.length) return
    setState({ pending: "cleanup", operationError: "" })
    await props.context.sdk.client.worktree
      .remove({ directory: props.root, worktreeRemoveInput: { directory: entry.directory } }, { throwOnError: true })
      .then(() => refresh())
      .catch((cause) => setState("operationError", errorMessage(cause, language.t("worktree.manager.operationFailed"))))
      .finally(() => setState({ pending: undefined, confirm: undefined }))
  }
  const preview = async () => {
    const entry = selected()
    if (!entry || entry.primary || entry.missing) return
    setState({ pending: "preview", mergeError: "", applied: false })
    await props.context.sdk.client.worktree
      .mergePreview(
        {
          query_directory: props.root,
          body_directory: entry.directory,
          resolutions: Object.entries(state.resolutions).map(([path, choice]) => ({ path, choice })),
        },
        { throwOnError: true },
      )
      .then((result) =>
        setState({
          preview: result.data,
          previewStale: false,
          resolutions: Object.fromEntries(result.data.resolutions.map((item) => [item.path, item.choice])),
        }),
      )
      .catch((cause) => setState("mergeError", errorMessage(cause, language.t("worktree.merge.previewFailed"))))
      .finally(() => setState("pending", undefined))
  }
  const apply = async () => {
    const value = state.preview
    if (!value || value.unresolved.length || state.previewStale || !value.files.length) return
    setState({ pending: "apply", mergeError: "" })
    await props.context.sdk.client.worktree
      .mergeApply(
        {
          query_directory: props.root,
          body_directory: value.directory,
          sourceHead: value.sourceHead,
          sourceTree: value.sourceTree,
          targetHead: value.targetHead,
          mergedTree: value.mergedTree,
          resolutions: value.resolutions,
          reviewID: value.reviewID,
        },
        { throwOnError: true },
      )
      .then(() => setState({ applied: true, preview: undefined }))
      .catch((cause) => {
        setState({ mergeError: errorMessage(cause, language.t("worktree.merge.applyFailed")), previewStale: true })
      })
      .finally(() => setState("pending", undefined))
  }

  return (
    <Dialog
      size="x-large"
      title={language.t("worktree.manager.title")}
      description={language.t("worktree.manager.description")}
      class="worktree-manager"
    >
      <div data-slot="worktree-manager-layout">
        <div data-slot="worktree-manager-list">
          <Button variant="ghost" size="small" disabled={entries.loading} onClick={() => void refresh()}>
            {language.t("worktree.manager.refresh")}
          </Button>
          <Show when={entries.loading && !entries.latest}>
            <div data-slot="worktree-manager-message">{language.t("worktree.manager.loading")}</div>
          </Show>
          <Show when={entriesError()}>
            <div data-slot="worktree-manager-message" role="alert">
              <span>{language.t("worktree.manager.loadFailed")}</span>
              <Button variant="ghost" size="small" onClick={() => void entriesAction.refetch()}>
                {language.t("worktree.manager.retry")}
              </Button>
            </div>
          </Show>
          <Show when={!entries.loading && !entriesError() && entryList()?.length === 0}>
            <div data-slot="worktree-manager-message">{language.t("worktree.manager.empty")}</div>
          </Show>
          <For each={entryList()}>
            {(entry) => (
              <button
                type="button"
                data-slot="worktree-manager-entry"
                data-selected={entry.directory === state.selected ? true : undefined}
                onClick={() => select(entry.directory)}
              >
                <span data-slot="worktree-manager-entry-title">
                  <span>{name(entry.directory)}</span>
                  <span data-slot="worktree-manager-badge">{language.t(statusKey(entry))}</span>
                </span>
                <span data-slot="worktree-manager-entry-meta">
                  {entry.branch ?? language.t("worktree.manager.branch.detached")} · {entry.sessions.length}
                </span>
              </button>
            )}
          </For>
        </div>
        <div data-slot="worktree-manager-details">
          <Show when={selected()} keyed>
            {(entry) => (
              <>
                <div data-slot="worktree-manager-heading">
                  <div>
                    <h2>{name(entry.directory)}</h2>
                    <span title={entry.directory}>{entry.directory}</span>
                  </div>
                  <span data-slot="worktree-manager-badge">{language.t(statusKey(entry))}</span>
                </div>
                <dl data-slot="worktree-manager-facts">
                  <div>
                    <dt>{language.t("worktree.manager.directoryStatus")}</dt>
                    <dd>
                      <span>
                        {language.t(
                          entry.usage.blocked ? "worktree.manager.status.inUse" : "worktree.manager.status.idle",
                        )}
                        {entry.usage.ownerIDs.length ? ` (${entry.usage.ownerIDs.length})` : ""}
                      </span>
                      <Show when={entry.owner} keyed>
                        {(owner) => <small>{language.t(ownerStateKey(owner))}</small>}
                      </Show>
                    </dd>
                  </div>
                  <div>
                    <dt>{language.t("worktree.manager.space")}</dt>
                    <dd>
                      {detailValue()?.space
                        ? bytes(detailValue()!.space!.bytes)
                        : language.t("worktree.manager.spacePending")}
                    </dd>
                  </div>
                </dl>
                <Show when={entry.owner?.lastError}>
                  <div data-slot="worktree-manager-error" role="alert">
                    <strong>{language.t("worktree.manager.ownerFailure")}</strong>
                    <span>{entry.owner!.lastError}</span>
                  </div>
                </Show>
                <section data-slot="worktree-manager-section">
                  <h3>{language.t("worktree.manager.sessions")}</h3>
                  <Show
                    when={entry.sessions.length}
                    fallback={<span>{language.t("worktree.manager.noSessions")}</span>}
                  >
                    <For each={entry.sessions}>
                      {(session) => (
                        <div data-slot="worktree-manager-session-row">
                          <button
                            type="button"
                            data-slot="worktree-manager-session"
                            onClick={() => openSession(session.id)}
                          >
                            <span>{session.title}</span>
                            <Show when={session.archived}>
                              <span>{language.t("worktree.manager.archived")}</span>
                            </Show>
                          </button>
                          <div data-slot="worktree-manager-session-actions">
                            <Button
                              variant="ghost"
                              size="small"
                              disabled={!!state.sessionPending}
                              onClick={() => void mutateSession(session, session.archived ? "restore" : "archive")}
                            >
                              {language.t(session.archived ? "workspace.task.restore" : "common.archive")}
                            </Button>
                            <Show when={entry.owner?.lastError && entry.owner.sessionID === session.id}>
                              <Button
                                variant="ghost"
                                size="small"
                                disabled={!!state.sessionPending}
                                onClick={() => void mutateSession(session, "archive")}
                              >
                                {language.t("workspace.task.cleanup.retry")}
                              </Button>
                            </Show>
                            <Button
                              variant="ghost"
                              size="small"
                              disabled={!!state.sessionPending}
                              onClick={() => setState("deleteSession", session.id)}
                            >
                              {language.t("common.delete")}
                            </Button>
                          </div>
                          <Show when={state.deleteSession === session.id}>
                            <div data-slot="worktree-manager-confirm">
                              <strong>{language.t("workspace.task.delete.title")}</strong>
                              <p>{language.t("workspace.task.delete.description", { title: session.title })}</p>
                              <div>
                                <Button variant="ghost" size="large" onClick={() => setState("deleteSession", "")}>
                                  {language.t("common.cancel")}
                                </Button>
                                <Button
                                  variant="primary"
                                  size="large"
                                  disabled={!!state.sessionPending}
                                  onClick={() => void mutateSession(session, "delete")}
                                >
                                  {language.t("common.delete")}
                                </Button>
                              </div>
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </section>
                <Show when={detailsError()}>
                  <div data-slot="worktree-manager-error" role="alert">
                    <span>{language.t("worktree.manager.loadFailed")}</span>
                    <Button variant="ghost" size="small" onClick={() => void detailsAction.refetch()}>
                      {language.t("worktree.manager.retry")}
                    </Button>
                  </div>
                </Show>
                <Show when={detailValue()?.ignored} keyed>
                  {(ignored) => (
                    <section data-slot="worktree-manager-section">
                      <h3>{language.t("worktree.manager.ignored.title")}</h3>
                      <p>{language.t("worktree.manager.ignored.description")}</p>
                      <IgnoredList label={language.t("worktree.manager.ignored.preserved")} items={ignored.preserved} />
                      <IgnoredList label={language.t("worktree.manager.ignored.skipped")} items={ignored.skipped} />
                      <IgnoredList
                        label={language.t("worktree.manager.ignored.unsupported")}
                        items={ignored.unsupported}
                      />
                    </section>
                  )}
                </Show>
                <div data-slot="worktree-manager-actions">
                  <Button
                    variant="secondary"
                    size="large"
                    disabled={entry.missing}
                    onClick={() => void openDirectory()}
                  >
                    {language.t("worktree.manager.open")}
                  </Button>
                  <Show when={!entry.primary && !entry.missing && entry.registered}>
                    <Button variant="secondary" size="large" onClick={() => void preview()} disabled={!!state.pending}>
                      {language.t("worktree.merge.preview")}
                    </Button>
                  </Show>
                  <Show when={entry.canAdopt}>
                    <Button variant="secondary" size="large" onClick={() => setState("confirm", "adopt")}>
                      {language.t("worktree.manager.adopt")}
                    </Button>
                  </Show>
                  <Show when={entry.orphan && !entry.primary && entry.sessions.length === 0}>
                    <Button variant="ghost" size="large" onClick={() => setState("confirm", "cleanup")}>
                      {language.t("worktree.manager.cleanup")}
                    </Button>
                  </Show>
                </div>
                <Show when={state.confirm}>
                  <div data-slot="worktree-manager-confirm">
                    <strong>
                      {language.t(
                        state.confirm === "adopt"
                          ? "worktree.manager.confirmAdoptTitle"
                          : "worktree.manager.confirmCleanupTitle",
                      )}
                    </strong>
                    <p>
                      {state.confirm === "adopt"
                        ? language.t("worktree.manager.confirmAdopt")
                        : language.t("worktree.manager.confirmCleanup", { directory: entry.directory })}
                    </p>
                    <div>
                      <Button variant="ghost" size="large" onClick={() => setState("confirm", undefined)}>
                        {language.t("worktree.manager.cancel")}
                      </Button>
                      <Button
                        variant="primary"
                        size="large"
                        disabled={!!state.pending}
                        onClick={() => void (state.confirm === "adopt" ? adopt() : cleanup())}
                      >
                        {language.t("worktree.manager.confirm")}
                      </Button>
                    </div>
                  </div>
                </Show>
                <Show when={state.operationError}>
                  <div data-slot="worktree-manager-error" role="alert">
                    {state.operationError}
                  </div>
                </Show>
                <Show when={state.preview || state.mergeError || state.applied}>
                  <section data-slot="worktree-merge-preview">
                    <h3>{language.t("worktree.merge.title")}</h3>
                    <p>{language.t("worktree.merge.description")}</p>
                    <Show when={state.applied}>
                      <div data-slot="worktree-manager-success" role="status">
                        {language.t("worktree.merge.applied")}
                      </div>
                    </Show>
                    <Show when={state.mergeError}>
                      <div data-slot="worktree-manager-error" role="alert">
                        {state.mergeError}
                      </div>
                      <Show when={!state.preview}>
                        <Button
                          variant="secondary"
                          size="large"
                          disabled={!!state.pending}
                          onClick={() => void preview()}
                        >
                          {language.t("worktree.merge.retry")}
                        </Button>
                      </Show>
                    </Show>
                    <Show when={state.preview} keyed>
                      {(value) => (
                        <>
                          <dl data-slot="worktree-manager-facts">
                            <div>
                              <dt>{language.t("worktree.merge.target")}</dt>
                              <dd>{value.target}</dd>
                            </div>
                            <div>
                              <dt>{language.t("worktree.merge.files")}</dt>
                              <dd>{value.files.length}</dd>
                            </div>
                          </dl>
                          <Show when={value.conflicts.length}>
                            <div data-slot="worktree-merge-conflicts">
                              <strong>{language.t("worktree.merge.conflicts")}</strong>
                              <p>{language.t("worktree.merge.conflictChoice")}</p>
                              <For each={value.conflicts}>
                                {(file, index) => (
                                  <fieldset data-slot="worktree-merge-resolution">
                                    <legend>{file}</legend>
                                    <label>
                                      <input
                                        type="radio"
                                        name={`worktree-conflict-${index()}`}
                                        checked={state.resolutions[file] === "target"}
                                        onChange={() => {
                                          setState("resolutions", file, "target")
                                          setState("previewStale", true)
                                        }}
                                      />
                                      <span>{language.t("worktree.merge.keepTarget")}</span>
                                    </label>
                                    <label>
                                      <input
                                        type="radio"
                                        name={`worktree-conflict-${index()}`}
                                        checked={state.resolutions[file] === "source"}
                                        onChange={() => {
                                          setState("resolutions", file, "source")
                                          setState("previewStale", true)
                                        }}
                                      />
                                      <span>{language.t("worktree.merge.useSource")}</span>
                                    </label>
                                  </fieldset>
                                )}
                              </For>
                              <Show when={value.unresolved.length && !state.previewStale}>
                                <span>{language.t("worktree.merge.unresolved")}</span>
                              </Show>
                              <Show when={state.previewStale}>
                                <span>{language.t("worktree.merge.selectionChanged")}</span>
                              </Show>
                              <span>{language.t("worktree.merge.directoriesUnchanged")}</span>
                            </div>
                          </Show>
                          <Show when={!value.files.length}>
                            <p>{language.t("worktree.merge.noChanges")}</p>
                          </Show>
                          <Show when={value.patch}>
                            <pre>{value.patch}</pre>
                          </Show>
                          <Show when={value.truncated}>
                            <span>{language.t("worktree.merge.truncated")}</span>
                          </Show>
                          <div data-slot="worktree-manager-actions">
                            <Button
                              variant="ghost"
                              size="large"
                              onClick={() => setState({ preview: undefined, resolutions: {}, previewStale: false })}
                            >
                              {language.t("worktree.merge.close")}
                            </Button>
                            <Button
                              variant="secondary"
                              size="large"
                              disabled={
                                !!state.pending || value.conflicts.some((file) => state.resolutions[file] === undefined)
                              }
                              onClick={() => void preview()}
                            >
                              {value.conflicts.length
                                ? language.t("worktree.merge.previewSelections")
                                : language.t("worktree.merge.retry")}
                            </Button>
                            <Button
                              variant="primary"
                              size="large"
                              disabled={
                                !!state.pending ||
                                state.previewStale ||
                                !!value.unresolved.length ||
                                !value.files.length
                              }
                              onClick={() => void apply()}
                            >
                              {language.t("worktree.merge.apply")}
                            </Button>
                          </div>
                        </>
                      )}
                    </Show>
                  </section>
                </Show>
                <p data-slot="worktree-manager-boundary">{language.t("worktree.manager.usageBoundary")}</p>
              </>
            )}
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

function IgnoredList(props: { label: string; items: Array<{ path: string; reason: string }> }) {
  const language = useLanguage()
  return (
    <div data-slot="worktree-manager-ignored">
      <strong>{props.label}</strong>
      <Show when={props.items.length} fallback={<span>{language.t("worktree.manager.ignored.none")}</span>}>
        <For each={props.items}>{(item) => <code title={item.reason}>{item.path}</code>}</For>
      </Show>
    </div>
  )
}

function statusKey(entry: Entry) {
  if (entry.primary) return "worktree.manager.status.primary" as const
  if (entry.missing) return "worktree.manager.status.missing" as const
  if (entry.shared) return "worktree.manager.status.shared" as const
  if (entry.managed) return "worktree.manager.status.managed" as const
  return "worktree.manager.status.unbound" as const
}

function ownerStateKey(owner: NonNullable<Entry["owner"]>) {
  if (owner.lastError) return "worktree.manager.ownerFailure" as const
  if (owner.intent === "archive") return "worktree.manager.lifecycle.archive" as const
  if (owner.intent === "restore") return "worktree.manager.lifecycle.restore" as const
  if (owner.intent === "delete") return "worktree.manager.lifecycle.delete" as const
  if (owner.phase === "removed") return "worktree.manager.lifecycle.reclaimed" as const
  if (owner.phase === "delete-preserve") return "worktree.manager.lifecycle.preserved" as const
  return "worktree.manager.status.managed" as const
}

function name(directory: string) {
  return (
    directory
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? directory
  )
}

function bytes(value: number | string) {
  if (typeof value !== "number") return "—"
  if (!Number.isFinite(value)) return "—"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
