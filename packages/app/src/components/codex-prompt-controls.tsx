import type { LabEnginesOutput } from "@opencode-ai/lab-client"
import type { SessionExternal } from "@opencode-ai/schema/session-external"
import { Select } from "@opencode-ai/ui/select"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { Accessor } from "solid-js"
import { createEffect, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptEngine, usePrompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useModels } from "@/context/models"
import type { PromptPermissionMode } from "@/components/prompt-permission-select"
import { showToast } from "@/utils/toast"

type CodexEngine = LabEnginesOutput[number]
type CodexModel = CodexEngine["models"][number]
type CodexSettings = SessionExternal.Settings

export function sharedCodexPermission(permission: CodexSettings["permission"]): PromptPermissionMode | undefined {
  if (permission === "workspace") return "default"
  if (permission === "default" || permission === "auto" || permission === "full") return permission
}

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

export function canSubmitWithCodexAccount(
  account: Pick<CodexEngine["account"], "authenticated" | "requiresAuth"> | undefined,
  model: Pick<CodexModel, "requiresAuth"> | undefined,
) {
  if (!account) return false
  if (!account.requiresAuth || account.authenticated) return true
  return model?.requiresAuth === false
}

export function createCodexPromptController(input: {
  prompt: ReturnType<typeof usePrompt>
  sessionID: Accessor<string | undefined>
  sessionEngine: Accessor<PromptEngine | undefined>
  restoreFocus: () => void
  initializeDefaultPermission?: boolean
}) {
  const serverSync = useServerSync()
  const models = useModels()
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
  const displayedModel = (model: CodexModel) => {
    const shared =
      model.provider && model.modelID
        ? models.find({ providerID: model.provider.id, modelID: model.modelID })
        : undefined
    return shared
      ? { ...model, name: shared.name, provider: { id: shared.provider.id, name: shared.provider.name } }
      : model
  }
  const model = (): CodexModel | undefined => {
    const modelID = settings().model
    if (!modelID) return input.sessionID() ? undefined : codex()?.models.find((item) => item.default)
    return displayedModel(
      codex()?.models.find((item) => item.id === modelID) ?? {
        id: modelID,
        name: modelID,
        default: false,
        efforts: [],
      },
    )
  }
  const effort = () => settings().effort ?? model()?.defaultEffort
  const permission = () => sharedCodexPermission(settings().permission)
  const canSubmit = () => {
    if (engine() !== "codex") return true
    if (!external().data.engines) return false
    if (!canSubmitWithCodexAccount(codex()?.account, model())) return false
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
  createEffect(() => {
    if (!input.initializeDefaultPermission || input.sessionID() || !input.prompt.ready()) return
    if (engine() !== "codex" || settings().permission !== undefined) return
    input.prompt.codex.set({ ...settings(), permission: "default" }, { explicit: false })
  })

  const update = async (patch: CodexSettings) => {
    const sessionID = input.sessionID()
    const next = updateCodexSettings(settings(), patch)
    if (!sessionID) {
      input.prompt.codex.set(next)
      input.restoreFocus()
      return true
    }
    if (state.busy) return false
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
    return !!updated
  }

  return {
    busy: () => state.busy,
    appliedSettings: () => descriptor()?.settings,
    pendingSettings: () => descriptor()?.pendingSettings,
    catalog: codex,
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
      options: () =>
        (codex()?.models ?? [])
          .filter(
            (model) =>
              !model.provider ||
              !model.modelID ||
              models.visible({ providerID: model.provider.id, modelID: model.modelID }),
          )
          .map(displayedModel),
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
      ready: () => !state.busy,
      current: permission,
      select(value: PromptPermissionMode) {
        if (value === permission()) return true
        return update({ permission: value })
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
    <Show
      when={props.controller.engine.mutable()}
      fallback={
        <span
          data-component="prompt-engine-label"
          aria-label={language.t("codex.engine.label")}
          class="max-w-[180px] truncate px-2 text-13-regular text-text-weak"
        >
          {props.controller.engine.current() === "codex" ? "Codex" : "OpenCode"}
        </span>
      }
    >
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
      groupBy={(value) => value.provider?.name ?? ""}
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

export function CodexPendingSettings(props: { controller: CodexPromptController }) {
  const language = useLanguage()
  const permission = () => {
    const value = props.controller.appliedSettings()?.permission
    if (value === "readOnly") return language.t("codex.permission.readOnly")
    if (value === "workspace" || value === "default") return language.t("prompt.permission.default.label")
    if (value === "auto") return language.t("prompt.permission.auto.label")
    if (value === "full") return language.t("prompt.permission.full.label")
    return language.t("codex.permission.nativeDefault")
  }
  return (
    <Show when={Object.values(props.controller.pendingSettings() ?? {}).some((value) => value !== undefined)}>
      <Tooltip
        value={language.t("codex.pendingSettings.hint", {
          model: props.controller.appliedSettings()?.model ?? language.t("codex.settings.nativeDefault"),
          effort: props.controller.appliedSettings()?.effort ?? language.t("codex.settings.nativeDefault"),
          permission: permission(),
        })}
      >
        <span data-component="codex-pending-settings" tabIndex={0} class="px-1 text-11-regular text-text-weak">
          {language.t("codex.pendingSettings.title")}
        </span>
      </Tooltip>
    </Show>
  )
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}
