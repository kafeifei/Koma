import { useStartupPending, useStartupTask } from "@/desktop/startup"
import { createPromptProjectController } from "@/components/prompt-project-selector"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useSettings } from "@/context/settings"
import { createEffect, createResource, untrack } from "solid-js"
import { createNewSessionDraftController } from "./new-session/new-session-draft-controller"
import { NewSessionStatus, NewSessionView } from "./new-session/new-session-view"
import { createNewSessionWorkspaceController } from "./new-session/new-session-workspace-controller"
import { useNewSessionCommands } from "./new-session/use-new-session-commands"

/** The draft-only V2 session page. Submitting promotes the draft into a real session. */
export default function NewSessionPage() {
  const startupPending = useStartupPending()
  const settings = useSettings()
  const rightMount = useTitlebarRightMount()
  const workspace = createNewSessionWorkspaceController()
  const draft = createNewSessionDraftController({
    projectRoot: workspace.project.root,
    worktree: workspace.selection.value,
    baseBranch: workspace.bar.submitBranch,
    ready: workspace.selection.ready,
    resetWorktree: workspace.selection.reset,
  })
  useStartupTask(
    "page",
    () => ({
      ready: draft.prompt.ready() && workspace.selection.ready(),
      error: workspace.selection.failed() ? new Error("Failed to load workspace branches") : undefined,
    }),
    true,
  )
  const project = createPromptProjectController({
    controls: draft.project.controls,
    onDone: draft.input.restoreFocus,
  })
  useNewSessionCommands({
    restoreFocus: draft.input.restoreFocus,
    project: {
      empty: project.empty,
      open: () => project.setOpen(true),
    },
  })
  createEffect(() => {
    if (startupPending() || !draft.prompt.ready()) return
    // Cursor edits must not retrigger autofocus and collapse the IME preedit selection.
    untrack(() => draft.input.restoreFocus())
  })
  const ready = Promise.resolve()
  const [suspendUntilPromptReady] = createResource(
    () => draft.prompt.readyPromise() ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {suspendUntilPromptReady()}
      <NewSessionStatus mount={rightMount} visible={settings.visibility.status} />
      <div class="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <NewSessionView input={draft.input} project={project} workspace={workspace} />
      </div>
    </div>
  )
}
