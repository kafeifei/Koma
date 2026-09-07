import { useSearchParams } from "@solidjs/router"
import { batch, createComputed, createEffect, createSignal } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { CodexPromptController } from "@/components/codex-prompt-controls"
import type { PromptPermissionController } from "@/components/prompt-permission-select"
import type { ModelSelection } from "@/context/local"
import type { CodexPromptSettings, PromptEngine, PromptModel, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { type DraftTab, type PermissionMode, useTabs } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"
import { Persist, persisted } from "@/utils/persist"
import { ScopedKey } from "@/utils/server-scope"

export type ComposerPreferences = {
  engine?: PromptEngine
  opencode?: {
    model?: PromptModel
    permission?: PermissionMode
  }
  codex?: CodexPromptSettings
}

export type SavedComposerPreferences = {
  target: Record<string, ComposerPreferences | undefined>
}

type Snapshot = {
  engine?: PromptEngine
  model?: PromptModel
  codex?: CodexPromptSettings
  permission: PermissionMode
}

export function sanitizeComposerPreferences(value: unknown): ComposerPreferences {
  const item = record(value)
  if (!item) return {}
  const opencode = record(item.opencode)
  const codex = record(item.codex)
  const model = promptModel(opencode?.model)
  const permission = permissionMode(opencode?.permission)
  return {
    ...(item.engine === "opencode" || item.engine === "codex" ? { engine: item.engine } : {}),
    ...(model || permission
      ? { opencode: { ...(model ? { model } : {}), ...(permission ? { permission } : {}) } }
      : {}),
    ...(codex ? { codex: codexSettings(codex) } : {}),
  }
}

export function normalizeOpenCodePreference(model: PromptModel, variants: string[]) {
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    ...(model.variant === null || (typeof model.variant === "string" && variants.includes(model.variant))
      ? { variant: model.variant }
      : {}),
  } satisfies PromptModel
}

export function initializeCodexPreference(
  current: CodexPromptSettings | undefined,
  saved: CodexPromptSettings | undefined,
) {
  const restored = current
    ? current.permission === undefined && saved?.permission !== undefined
      ? { ...current, permission: saved.permission }
      : current
    : saved
  if (restored?.permission !== undefined) return restored
  return { ...restored, permission: "default" as const }
}

export function createNewSessionComposerPreferences(input: {
  projectRoot: () => string | undefined
  prompt: ReturnType<typeof usePrompt>
  model: ModelSelection
  permission: PromptPermissionController
  codex: CodexPromptController
}) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const tabs = useTabs()
  const [search] = useSearchParams<{ draftId?: string }>()
  const [saved, setSaved, , ready] = persisted(
    {
      ...Persist.global("composer-preferences"),
      migrate(value) {
        const item = record(value)
        const targets = record(item?.target)
        return {
          target: Object.fromEntries(
            Object.entries(targets ?? {}).map(([key, preference]) => [key, sanitizeComposerPreferences(preference)]),
          ),
        }
      },
    },
    createStore<SavedComposerPreferences>({ target: {} }),
  )
  const [initialized, setInitialized] = createSignal<string>()
  let previous: Snapshot | undefined

  const projectKey = () => {
    const root = input.projectRoot()
    if (!root) return
    return ScopedKey.from(serverSDK().scope, pathKey(root))
  }
  const preference = () => {
    const key = projectKey()
    if (!key) return
    return saved.target[key]
  }
  const inputKey = () => {
    const key = projectKey()
    if (!key) return
    return JSON.stringify([key, search.draftId ?? sdk().directory])
  }
  const draft = () =>
    search.draftId
      ? tabs.store.find(
          (item): item is DraftTab =>
            item.type === "draft" &&
            item.draftID === search.draftId &&
            item.directory === sdk().directory &&
            item.server === ServerConnection.key(serverSDK().server),
        )
      : undefined
  const snapshot = (): Snapshot => {
    const value = input.prompt.capture().store[0]()
    return {
      engine: value.engine,
      model: value.model ? { ...value.model } : undefined,
      codex: value.codex ? { ...value.codex } : undefined,
      permission: input.permission.current(),
    }
  }

  createEffect(() => {
    const key = projectKey()
    const currentInput = inputKey()
    const current = preference()
    if (
      !key ||
      !currentInput ||
      initialized() === currentInput ||
      !ready() ||
      !input.prompt.ready() ||
      !input.permission.ready()
    )
      return
    const value = input.prompt.capture().store[0]()
    if (value.externalRequest) {
      previous = undefined
      setInitialized(currentInput)
      return
    }

    const restoreEngine = !value.engine && !value.model && !value.codex
    const initializedCodex = initializeCodexPreference(value.codex, current?.codex)
    batch(() => {
      if (restoreEngine && current?.engine) input.prompt.engine.set(current.engine)
      if (!value.model && current?.opencode?.model) input.prompt.model.set({ ...current.opencode.model })
      if (!same(value.codex, initializedCodex)) input.prompt.codex.set(initializedCodex, { explicit: false })
      if (!draft()?.permissionMode && current?.opencode?.permission)
        void input.permission.select(current.opencode.permission)
    })
    previous = undefined
    setInitialized(currentInput)
  })

  createComputed(() => {
    const key = projectKey()
    if (!key || initialized() !== inputKey()) return
    const next = snapshot()
    if (!previous) {
      previous = next
      return
    }

    if (!same(previous.engine, next.engine) && next.engine)
      updateComposerPreference(saved, setSaved, key, { engine: next.engine })
    if (!same(previous.model, next.model) && next.model) {
      updateComposerPreference(saved, setSaved, key, {
        opencode: { model: normalizeOpenCodePreference(next.model, input.model.variant.list()) },
      })
    }
    if (!same(previous.permission, next.permission))
      updateComposerPreference(saved, setSaved, key, { opencode: { permission: next.permission } })
    if (!same(previous.codex, next.codex) && next.codex) {
      const catalog = input.codex.catalog()
      const selected = next.codex.model ? catalog?.models.find((item) => item.id === next.codex?.model) : undefined
      const model = selected ?? catalog?.models.find((item) => item.default)
      if (previous.codex?.model !== next.codex.model && selected)
        updateComposerPreference(saved, setSaved, key, { codex: { model: selected.id } })
      if (
        previous.codex?.effort !== next.codex.effort &&
        next.codex.effort &&
        model?.efforts.includes(next.codex.effort)
      )
        updateComposerPreference(saved, setSaved, key, { codex: { effort: next.codex.effort } })
      if (previous.codex?.permission !== next.codex.permission)
        updateComposerPreference(saved, setSaved, key, { codex: { permission: next.codex.permission } })
    }
    previous = next
  })

  return { ready }
}

export function updateComposerPreference(
  saved: Store<SavedComposerPreferences>,
  setSaved: SetStoreFunction<SavedComposerPreferences>,
  key: string,
  patch: ComposerPreferences,
) {
  setSaved("target", key, {
    ...saved.target[key],
    ...patch,
    ...(patch.opencode ? { opencode: { ...saved.target[key]?.opencode, ...patch.opencode } } : {}),
    ...(patch.codex ? { codex: { ...saved.target[key]?.codex, ...patch.codex } } : {}),
  })
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function promptModel(value: unknown): PromptModel | undefined {
  const item = record(value)
  if (!item || typeof item.providerID !== "string" || typeof item.modelID !== "string") return
  return {
    providerID: item.providerID,
    modelID: item.modelID,
    ...(typeof item.variant === "string" || item.variant === null ? { variant: item.variant } : {}),
  }
}

function permissionMode(value: unknown): PermissionMode | undefined {
  if (value === "default" || value === "auto" || value === "full") return value
}

function codexSettings(value: Record<string, unknown>): CodexPromptSettings {
  return {
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.effort === "string" ? { effort: value.effort } : {}),
    ...(value.permission === "default" ||
    value.permission === "auto" ||
    value.permission === "workspace" ||
    value.permission === "readOnly" ||
    value.permission === "full"
      ? { permission: value.permission }
      : {}),
  }
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}
