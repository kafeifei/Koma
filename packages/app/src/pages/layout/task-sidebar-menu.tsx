import { Show, splitProps, type JSX, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { errorMessage } from "./helpers"
import { showToast } from "@/utils/toast"
import "./task-sidebar-menu.css"

export type TaskSidebarMenuProps = {
  children: JSX.Element
  title: string
  pinned: boolean
  archived: boolean
  busy: boolean
  running: boolean
  cleanupStatus: () => Promise<{ managed: boolean; operation?: string; state?: string; message?: string }>
  onDelete: () => Promise<void>
  canMutate: boolean
  onPin: () => void
  onRename: (title: string) => Promise<void>
  onArchive: () => Promise<void>
  onRestore: () => Promise<void>
}

export function TaskSidebarMenu(props: TaskSidebarMenuProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const [cleanup, setCleanup] = createStore({ retry: false, message: undefined as string | undefined })
  const inspect = (open: boolean) => {
    if (!open || !props.archived || !props.canMutate) return
    void props.cleanupStatus().then(
      (status) =>
        setCleanup({
          retry:
            status.managed &&
            status.operation === "archive" &&
            (status.state === "pending" || status.state === "failed"),
          message: status.message,
        }),
      () => setCleanup({ retry: false, message: undefined }),
    )
  }
  const openDelete = () => dialog.show(() => <TaskDeleteDialog title={props.title} onDelete={props.onDelete} />)
  const retryCleanup = () =>
    void props
      .onArchive()
      .then(() => inspect(true))
      .catch((cause) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(cause, language.t("common.requestFailed")),
        }),
      )
  const pinLabel = () => language.t(props.pinned ? "workspace.task.unpin" : "workspace.task.pin")
  const archiveLabel = () => language.t(props.archived ? "workspace.task.restore" : "common.archive")
  const archiveDisabled = () => !props.canMutate || props.busy
  const openRename = () => dialog.show(() => <TaskRenameDialog title={props.title} onRename={props.onRename} />)
  const toggleArchive = () =>
    void (props.archived ? props.onRestore() : props.onArchive()).catch((cause) =>
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      }),
    )

  return (
    <ContextMenu onOpenChange={inspect}>
      <ContextMenu.Trigger as={TaskRow} class="task-sidebar-menu">
        {props.children}
        <DropdownMenu placement="bottom-end" gutter={4} onOpenChange={inspect}>
          <DropdownMenu.Trigger
            as="button"
            type="button"
            class="task-sidebar-menu-trigger"
            aria-label={language.t("common.moreOptions")}
            title={language.t("common.moreOptions")}
          >
            …
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <DropdownMenu.Item onSelect={props.onPin}>
                <DropdownMenu.ItemLabel>{pinLabel()}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={openRename}>
                <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={archiveDisabled()} onSelect={toggleArchive}>
                <DropdownMenu.ItemLabel>{archiveLabel()}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <Show when={cleanup.retry}>
                <DropdownMenu.Item disabled={archiveDisabled()} onSelect={retryCleanup} title={cleanup.message}>
                  <DropdownMenu.ItemLabel>{language.t("workspace.task.cleanup.retry")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Item disabled={!props.canMutate || props.busy || props.running} onSelect={openDelete}>
                <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={props.onPin}>
            <ContextMenu.ItemLabel>{pinLabel()}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={openRename}>
            <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item disabled={archiveDisabled()} onSelect={toggleArchive}>
            <ContextMenu.ItemLabel>{archiveLabel()}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <Show when={cleanup.retry}>
            <ContextMenu.Item disabled={archiveDisabled()} onSelect={retryCleanup} title={cleanup.message}>
              <ContextMenu.ItemLabel>{language.t("workspace.task.cleanup.retry")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </Show>
          <ContextMenu.Item disabled={!props.canMutate || props.busy || props.running} onSelect={openDelete}>
            <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

function TaskRow(props: ParentProps<JSX.HTMLAttributes<HTMLDivElement>>) {
  const [local, rest] = splitProps(props, ["children"])
  return (
    <div {...rest} data-slot="workspace-task-row">
      {local.children}
    </div>
  )
}

function TaskRenameDialog(props: { title: string; onRename: (title: string) => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({ title: props.title, pending: false, error: undefined as string | undefined })

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const next = state.title.trim()
    if (!next || state.pending) return
    setState({ pending: true, error: undefined })
    void props.onRename(next).then(
      () => dialog.close(),
      (err) => {
        setState({ error: errorMessage(err, language.t("common.requestFailed")), pending: false })
      },
    )
  }

  return (
    <Dialog title={language.t("workspace.task.rename.title")} class="w-full max-w-[420px] mx-auto">
      <form onSubmit={submit} class="flex flex-col gap-6 p-6 pt-0">
        <TextField
          autofocus
          type="text"
          label={language.t("workspace.task.rename.name")}
          value={state.title}
          onChange={(title) => setState("title", title)}
          validationState={state.error ? "invalid" : undefined}
          error={state.error}
          disabled={state.pending}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" disabled={state.pending} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={state.pending || !state.title.trim()}>
            {state.pending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function TaskDeleteDialog(props: { title: string; onDelete: () => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({ pending: false, error: undefined as string | undefined })
  const remove = () => {
    if (state.pending) return
    setState({ pending: true, error: undefined })
    void props.onDelete().then(
      () => dialog.close(),
      (cause) => setState({ pending: false, error: errorMessage(cause, language.t("common.requestFailed")) }),
    )
  }
  return (
    <Dialog title={language.t("workspace.task.delete.title")} class="w-full max-w-[420px] mx-auto">
      <div class="flex flex-col gap-6 p-6 pt-0">
        <p>{language.t("workspace.task.delete.description", { title: props.title })}</p>
        <Show when={state.error}>
          <p role="alert">{state.error}</p>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" disabled={state.pending} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={state.pending} onClick={remove}>
            {language.t("common.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
