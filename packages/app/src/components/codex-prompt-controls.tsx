import type { LabEnginesOutput } from "@opencode-ai/lab-client"
import { Select } from "@opencode-ai/ui/select"
import type { Accessor } from "solid-js"
import { onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptEngine, usePrompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"

type CodexEngine = LabEnginesOutput[number]
type CodexModel = CodexEngine["models"][number]
type CodexSettings = { model?: string; effort?: string; permission?: "workspace" | "readOnly" | "full" }

export function desiredCodexSettings(
  descriptor: { settings: CodexSettings; pendingSettings?: CodexSettings } | undefined,
  draft: CodexSettings,
) {
  if (!descriptor) return draft
  return { ...descriptor.settings, ...descriptor.pendingSettings }
}

export function updateCodexSettings(current: CodexSettings, patch: CodexSettings) {
  return { ...current, ...patch }
}

export function createCodexPromptController(input: {
  prompt: ReturnType<typeof usePrompt>
  sessionID: Accessor<string | undefined>
  sessionEngine: Accessor<PromptEngine | undefined>
  restoreFocus: () => void
}) {
  const serverSync = useServerSync()
  const language = useLanguage()
  const external = () => serverSync().external
  const [state, setState] = createStore({ busy: false })
  const descriptor = () => {
    const sessionID = input.sessionID()
    return sessionID ? external().data.descriptors[sessionID] : undefined
  }
  const engine = () => input.sessionEngine() ?? input.prompt.engine.current()
  const codex = () => external().data.engines?.find((item) => item.id === "codex")
  const settings = () => desiredCodexSettings(descriptor(), input.prompt.codex.current())
  const model = () => {
    const modelID = settings().model
    if (!modelID) return input.sessionID() ? undefined : codex()?.models.find((item) => item.default)
    return (
      codex()?.models.find((item) => item.id === modelID) ?? {
        id: modelID,
        name: modelID,
        default: false,
        efforts: [],
      }
    )
  }
  const effort = () => settings().effort ?? model()?.defaultEffort
  const permission = () => settings().permission ?? "native"
  const canSubmit = () => {
    if (engine() !== "codex") return true
    if (!external().data.engines) return false
    if (codex()?.account.requiresAuth && !codex()?.account.authenticated) return false
    const sessionID = input.sessionID()
    if (!sessionID) return codex()?.available === true && codex()?.capabilities.prompt === true
    const current = descriptor()
    if (!current?.capabilities.prompt) return false
    return !["disconnected", "systemError", "bindingUnavailable"].includes(current.runtimeStatus)
  }

  let enginesRequest: Promise<LabEnginesOutput> | undefined
  const refreshEngines = () => {
    if (external().data.engines) return
    if (enginesRequest) return enginesRequest
    enginesRequest = external()
      .refreshEngines()
      .finally(() => (enginesRequest = undefined))
    return enginesRequest
  }
  onMount(() => void refreshEngines()?.catch(() => undefined))

  const update = async (patch: { model?: string; effort?: string; permission?: "workspace" | "readOnly" | "full" }) => {
    const sessionID = input.sessionID()
    const next = updateCodexSettings(settings(), patch)
    if (!sessionID) {
      input.prompt.codex.set(next)
      input.restoreFocus()
      return
    }
    if (state.busy) return
    const previous = input.prompt.codex.current()
    input.prompt.codex.set(next)
    setState("busy", true)
    const updated = await external()
      .actions.settings({ sessionID, ...next })
      .catch((error) => {
        showToast({ title: language.t("codex.settings.updateFailed"), description: errorMessage(error) })
        return undefined
      })
    if (!updated) input.prompt.codex.set(previous, { explicit: false })
    setState("busy", false)
    input.restoreFocus()
  }

  return {
    busy: () => state.busy,
    canSubmit,
    session: () => !!input.sessionID(),
    engine: {
      current: engine,
      mutable: () => !input.sessionID() && external().data.support !== "unsupported",
      select(value: PromptEngine | undefined) {
        if (!value || value === engine() || input.sessionID()) return
        if (value === "codex" && codex()?.available === false) {
          showToast({ title: language.t("codex.account.unavailable"), description: codex()?.error })
          return
        }
        input.prompt.engine.set(value)
        if (value === "codex") void refreshEngines()?.catch(() => undefined)
        input.restoreFocus()
      },
    },
    model: {
      options: () => codex()?.models ?? [],
      current: model,
      select(value: CodexModel | undefined) {
        if (!value || value.id === model()?.id) return
        const nextEffort = value.efforts.includes(effort() ?? "") ? effort() : value.defaultEffort
        void update({ model: value.id, effort: nextEffort })
      },
    },
    effort: {
      options: () => {
        const values = model()?.efforts ?? []
        const current = effort()
        if (!current || values.includes(current)) return values
        return [current, ...values]
      },
      current: effort,
      select(value: string | undefined) {
        if (!value || value === effort()) return
        void update({ effort: value })
      },
    },
    permission: {
      current: permission,
      select(value: "native" | "workspace" | "readOnly" | "full" | undefined) {
        if (!value || value === permission()) return
        void update({ permission: value === "native" ? undefined : value })
      },
    },
  }
}

export type CodexPromptController = ReturnType<typeof createCodexPromptController>

const classes = "max-w-[180px] text-text-base"
const valueClasses = "truncate text-13-regular text-text-base"

export function PromptEngineSelect(props: { controller: CodexPromptController }) {
  const language = useLanguage()
  return (
    <Show when={props.controller.engine.mutable()}>
      <Select
        size="normal"
        options={["opencode", "codex"] as PromptEngine[]}
        current={props.controller.engine.current()}
        label={(value) => (value === "codex" ? "Codex" : "OpenCode")}
        onSelect={props.controller.engine.select}
        class={classes}
        valueClass={valueClasses}
        triggerProps={{ "data-action": "prompt-engine", "aria-label": language.t("codex.engine.label") }}
        variant="ghost"
      />
    </Show>
  )
}

export function CodexModelSelect(props: { controller: CodexPromptController }) {
  const language = useLanguage()
  return (
    <Select
      size="normal"
      options={[...props.controller.model.options()]}
      current={props.controller.model.current()}
      value={(value) => value.id}
      label={(value) => value.name}
      placeholder={
        props.controller.session() ? language.t("codex.settings.nativeDefault") : language.t("codex.settings.model")
      }
      disabled={props.controller.busy()}
      onSelect={props.controller.model.select}
      class={classes}
      valueClass={valueClasses}
      triggerProps={{ "data-action": "prompt-codex-model", "aria-label": language.t("codex.settings.model") }}
      variant="ghost"
    />
  )
}

export function CodexEffortSelect(props: { controller: CodexPromptController }) {
  const language = useLanguage()
  return (
    <Show when={props.controller.effort.options().length > 0}>
      <Select
        size="normal"
        options={[...props.controller.effort.options()]}
        current={props.controller.effort.current()}
        disabled={props.controller.busy()}
        onSelect={props.controller.effort.select}
        class={classes}
        valueClass={valueClasses}
        triggerProps={{ "data-action": "prompt-codex-effort", "aria-label": language.t("codex.settings.effort") }}
        variant="ghost"
      />
    </Show>
  )
}

export function CodexPermissionSelect(props: { controller: CodexPromptController }) {
  const language = useLanguage()
  const label = (value: "native" | "workspace" | "readOnly" | "full") => {
    if (value === "native") return language.t("codex.permission.nativeDefault")
    if (value === "workspace") return language.t("codex.permission.workspace")
    if (value === "readOnly") return language.t("codex.permission.readOnly")
    return language.t("codex.permission.full")
  }
  return (
    <Select
      size="normal"
      options={["native", "workspace", "readOnly", "full"] as ("native" | "workspace" | "readOnly" | "full")[]}
      current={props.controller.permission.current()}
      disabled={props.controller.busy()}
      label={label}
      onSelect={props.controller.permission.select}
      class={classes}
      valueClass={valueClasses}
      triggerProps={{ "data-action": "prompt-codex-permission", "aria-label": language.t("codex.settings.permission") }}
      variant="ghost"
    />
  )
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}
