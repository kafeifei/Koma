import { useSearchParams } from "@solidjs/router"
import { createEffect, untrack } from "solid-js"
import { usePromptInputV2Controller } from "@/components/prompt-input-v2"
import { useComments } from "@/context/comments"
import { useLocal } from "@/context/local"
import { usePrompt } from "@/context/prompt"
import { prefillDirectoryInput } from "@/context/input-retention"
import { useServerSync } from "@/context/server-sync"
import { createPromptInputController, createPromptProjectControls } from "@/pages/session/composer"
import { createPromptModelSelection } from "@/pages/session/composer/prompt-model-selection"
import { useSessionKey } from "@/pages/session/session-layout"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { createNewSessionComposerPreferences } from "./composer-preferences"

export function createNewSessionDraftController(workspace: {
  projectRoot: () => string | undefined
  worktree: () => string
  baseBranch: () => string | undefined
  ready: () => boolean
  resetWorktree: () => void
}) {
  const prompt = usePrompt()
  const serverSync = useServerSync()
  const comments = useComments()
  const local = useLocal()
  const route = useSessionKey()
  const [searchParams, setSearchParams] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const model = createPromptModelSelection({ agent: () => local.agent.current() })

  useComposerCommands({ model })

  const controls = createPromptInputController({
    sessionKey: route.sessionKey,
    sessionID: () => route.params.id,
    get queryOptions() {
      return serverSync().queryOptions
    },
    model,
  })
  const projectControls = createPromptProjectControls()
  const input = usePromptInputV2Controller({
    get controls() {
      return controls()
    },
    get newSessionWorktree() {
      return workspace.worktree()
    },
    get newSessionBaseBranch() {
      return workspace.baseBranch()
    },
    get newSessionWorktreeReady() {
      return workspace.ready()
    },
    onNewSessionWorktreeReset: workspace.resetWorktree,
    onSubmit: comments.clear,
  })
  createNewSessionComposerPreferences({
    projectRoot: workspace.projectRoot,
    prompt,
    model,
    permission: input.permission,
    codex: input.codex,
  })

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      const text = searchParams.prompt
      if (!text) return
      void prefillDirectoryInput({ ...prompt.capture(), ready: prompt.ready }, text)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  return {
    input,
    prompt: {
      ready: prompt.ready,
      readyPromise: () => prompt.ready.promise,
    },
    project: {
      controls: projectControls,
    },
  }
}

export type NewSessionDraftController = ReturnType<typeof createNewSessionDraftController>
