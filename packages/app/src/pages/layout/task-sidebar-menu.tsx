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
  canDelete: boolean
  onRetryCapabilities?: () => void
  onPin: () => void
  onRename: (title: string) => Promise<void>
  onArchive: () => Promise<void>
  onRestore: () => Promise<void>
}

export function TaskSidebarMenu(props: TaskSidebarMenuProps) {
  const dialog = useDialog()
  const language = useLanguage()
  let dropdownContent: HTMLDivElement | undefined
  let contextContent: HTMLDivElement | undefined
  const preserveNewMenuFocus = (event: Event) => {
    // A closing context menu must not steal focus from a newly opened menu on the same task.
    if (
      [dropdownContent, contextContent].some(
        (content) => content !== event.currentTarget && content?.isConnected && content.hasAttribute("data-expanded"),
      )
    )
      event.preventDefault()
  }
  const [cleanup, setCleanup] = createStore({ retry: false, message: undefined as string | undefined })
  const inspect = (open: boolean) => {
    if (!open) return
    if (!props.canMutate) props.onRetryCapabilities?.()
    if (!props.archived || !props.canMutate) return
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

  const activateShortcut: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return
    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    )
      return
    const key = event.key.toLowerCase()
    if (!["p", "r", "a", "c", "d"].includes(key)) return
    const item = event.currentTarget.querySelector<HTMLElement>(`[data-task-menu-key="${key}"]:not([data-disabled])`)
    if (!item) return
    event.preventDefault()
    event.stopPropagation()
    // Kobalte commits menu selection on pointerup; click() only updates its selection manager.
    item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
  }

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
            <DropdownMenu.Content
              ref={dropdownContent}
              data-prevent-autofocus
              onKeyDown={activateShortcut}
              onCloseAutoFocus={preserveNewMenuFocus}
            >
              <DropdownMenu.Item data-task-menu-key="p" aria-keyshortcuts="P" onSelect={props.onPin}>
                <DropdownMenu.ItemLabel>{pinLabel()}</DropdownMenu.ItemLabel>
                <TaskMenuShortcut>P</TaskMenuShortcut>
              </DropdownMenu.Item>
              <DropdownMenu.Item data-task-menu-key="r" aria-keyshortcuts="R" onSelect={openRename}>
                <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                <TaskMenuShortcut>R</TaskMenuShortcut>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-task-menu-key="a"
                aria-keyshortcuts="A"
                disabled={archiveDisabled()}
                onSelect={toggleArchive}
              >
                <DropdownMenu.ItemLabel>{archiveLabel()}</DropdownMenu.ItemLabel>
                <TaskMenuShortcut>A</TaskMenuShortcut>
              </DropdownMenu.Item>
              <Show when={cleanup.retry}>
                <DropdownMenu.Item
                  data-task-menu-key="c"
                  aria-keyshortcuts="C"
                  disabled={archiveDisabled()}
                  onSelect={retryCleanup}
                  title={cleanup.message}
                >
                  <DropdownMenu.ItemLabel>{language.t("workspace.task.cleanup.retry")}</DropdownMenu.ItemLabel>
                  <TaskMenuShortcut>C</TaskMenuShortcut>
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Item
                data-task-menu-key="d"
                aria-keyshortcuts="D"
                disabled={!props.canDelete || props.busy || props.running}
                onSelect={openDelete}
              >
                <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                <TaskMenuShortcut>D</TaskMenuShortcut>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          ref={contextContent}
          data-prevent-autofocus
          onKeyDown={activateShortcut}
          onCloseAutoFocus={preserveNewMenuFocus}
        >
          <ContextMenu.Item data-task-menu-key="p" aria-keyshortcuts="P" onSelect={props.onPin}>
            <ContextMenu.ItemLabel>{pinLabel()}</ContextMenu.ItemLabel>
            <TaskMenuShortcut>P</TaskMenuShortcut>
          </ContextMenu.Item>
          <ContextMenu.Item data-task-menu-key="r" aria-keyshortcuts="R" onSelect={openRename}>
            <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
            <TaskMenuShortcut>R</TaskMenuShortcut>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-task-menu-key="a"
            aria-keyshortcuts="A"
            disabled={archiveDisabled()}
            onSelect={toggleArchive}
          >
            <ContextMenu.ItemLabel>{archiveLabel()}</ContextMenu.ItemLabel>
            <TaskMenuShortcut>A</TaskMenuShortcut>
          </ContextMenu.Item>
          <Show when={cleanup.retry}>
            <ContextMenu.Item
              data-task-menu-key="c"
              aria-keyshortcuts="C"
              disabled={archiveDisabled()}
              onSelect={retryCleanup}
              title={cleanup.message}
            >
              <ContextMenu.ItemLabel>{language.t("workspace.task.cleanup.retry")}</ContextMenu.ItemLabel>
              <TaskMenuShortcut>C</TaskMenuShortcut>
            </ContextMenu.Item>
          </Show>
          <ContextMenu.Item
            data-task-menu-key="d"
            aria-keyshortcuts="D"
            disabled={!props.canDelete || props.busy || props.running}
            onSelect={openDelete}
          >
            <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
            <TaskMenuShortcut>D</TaskMenuShortcut>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

function TaskMenuShortcut(props: ParentProps) {
  return (
    <span class="task-sidebar-menu-shortcut" aria-hidden="true">
      {props.children}
    </span>
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
