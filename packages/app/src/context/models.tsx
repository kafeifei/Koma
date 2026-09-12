import {
  type Accessor,
  type ParentProps,
  createContext,
  createMemo,
  createResource,
  createEffect,
  on,
  useContext,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useServerSync } from "@/context/server-sync"
import { providerCodexModel, unifiedModelCatalog } from "./model-catalog"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

function createPreferences() {
  return persisted(Persist.global("model", ["model.v1"]), createStore<Store>({ user: [], recent: [], variant: {} }))
}

const PreferencesContext = createContext<ReturnType<typeof createPreferences>>()

export function ModelsProvider(props: ParentProps<{ directory?: Accessor<string | undefined> }>) {
  // Settings and task directories have different catalogs, but edit the same
  // persisted preferences. Nested catalogs must not create independent writers.
  const preferences = useContext(PreferencesContext) ?? createPreferences()
  return (
    <PreferencesContext.Provider value={preferences}>
      <ModelCatalogProvider directory={props.directory}>{props.children}</ModelCatalogProvider>
    </PreferencesContext.Provider>
  )
}

const { use: useModels, provider: ModelCatalogProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> } = {}) => {
    const providers = useProviders(() => props.directory?.())
    const serverSync = useServerSync()
    createEffect(
      on(
        () => serverSync().external,
        (external) => {
          if (!external.data.engines) void external.refreshEngines().catch(() => undefined)
        },
      ),
    )
    const codexModels = () => serverSync().external.data.engines?.find((engine) => engine.id === "codex")?.models ?? []

    const preferences = useContext(PreferencesContext)
    if (!preferences) throw new Error("Model preferences context is unavailable")
    const [store, setStore, _, ready] = preferences

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromISO(model.release_date)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter(
          (x) =>
            Math.abs(
              (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
                .diffNow()
                .as("months"),
            ) < 6,
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const catalog = createMemo(() => unifiedModelCatalog(list(), codexModels()))
    const codex = createMemo(() =>
      codexModels()
        .map(providerCodexModel)
        .map((model) => {
          const shared = catalog().find((item) => item.provider.id === model.provider.id && item.id === model.modelID)
          return shared ? { ...model, name: shared.name, provider: shared.provider } : model
        }),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      const date = release().get(key)
      if (!date?.isValid) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const providerModels = (providerID: string) => catalog().filter((model) => model.provider.id === providerID)
    const providerVisible = (providerID: string) => {
      const models = providerModels(providerID)
      return models.length > 0 && models.every((model) => visible({ providerID, modelID: model.id }))
    }
    const setProviderVisibility = (providerID: string, state: boolean) =>
      setStore(
        "user",
        produce((user) => {
          providerModels(providerID).forEach((model) => {
            const current = user.find((item) => item.providerID === providerID && item.modelID === model.id)
            if (current) current.visibility = state ? "show" : "hide"
            if (!current) user.push({ providerID, modelID: model.id, visibility: state ? "show" : "hide" })
          })
        }),
      )

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      list,
      catalog,
      codex,
      find,
      visible,
      setVisibility,
      providerVisible,
      setProviderVisibility,
      recent: {
        list: () => recentModels()!,
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})

export { useModels }
