export * as CodexProvider from "./codex"

import { CodexProviders } from "@opencode-ai/codex/providers"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Layer } from "effect"
import { Auth } from "../auth"
import { GlobalBus, type GlobalEvent } from "../bus/global"
import { Config } from "../config/config"
import { EffectBridge } from "../effect/bridge"
import { Provider } from "./provider"

const nativeEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
const responsesCompatibleSDKs = new Set(["@ai-sdk/openai", "@ai-sdk/openai-compatible"])

export const node = makeGlobalNode({
  service: CodexProviders.Service,
  layer: Layer.effect(
    CodexProviders.Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const config = yield* Config.Service
      const modelsDev = yield* ModelsDev.Service
      const bridge = yield* EffectBridge.make()

      const resolve = () =>
        Effect.gen(function* () {
          const cfg = yield* config.getGlobal()
          const catalog = yield* modelsDev.get()
          const credentials = yield* auth.all()
          return configuredProviders(cfg, catalog, credentials)
        })

      return CodexProviders.Service.of({
        list: () => bridge.promise(resolve().pipe(Effect.map((providers) => providers.map((item) => item.provider)))),
        key: (providerID, baseURL) =>
          bridge.promise(
            resolve().pipe(
              Effect.map((providers) => {
                const provider = providers.find((item) => item.provider.id === providerID)
                if (provider?.provider.baseURL !== baseURL) return
                return provider.key
              }),
            ),
          ),
        onChange: (listener) => {
          const unsubscribeAuth = Effect.runSync(auth.onSelection(() => listener()))
          const onGlobalEvent = (event: GlobalEvent) => {
            if (event.payload?.type === "global.disposed") listener()
          }
          GlobalBus.on("event", onGlobalEvent)
          return () => {
            unsubscribeAuth()
            GlobalBus.off("event", onGlobalEvent)
          }
        },
      })
    }),
  ),
  deps: [Auth.node, Config.node, ModelsDev.node],
})

function configuredProviders(
  cfg: ConfigV1.Info,
  catalog: Record<string, ModelsDev.Provider>,
  credentials: Record<string, Auth.Info>,
) {
  const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : undefined
  const disabled = new Set(cfg.disabled_providers ?? [])
  const configured = cfg.provider ?? {}
  const database = Provider.applyConfiguredProviders(
    Object.fromEntries(
      Object.keys(configured).flatMap((providerID) => {
        const provider = catalog[providerID]
        if (!provider) return []
        return [[providerID, Provider.toPublicInfo(Provider.fromModelsDevProvider(provider))]]
      }),
    ),
    configured,
    catalog,
  )

  return Object.keys(configured).flatMap((providerID) => {
    if (enabled && !enabled.has(providerID)) return []
    if (disabled.has(providerID)) return []

    const provider = database[providerID]
    if (!provider) return []
    const models = configuredModels(provider, configured[providerID])
    if (!models) return []
    const key = apiKey(provider, credentials[providerID])
    if (!key) return []
    return [
      {
        key,
        provider: {
          id: provider.id,
          name: provider.name,
          baseURL: models.baseURL,
          models: models.items,
        } satisfies CodexProviders.Provider,
      },
    ]
  })
}

function apiKey(provider: Provider.Info, auth: Auth.Info | undefined) {
  const configured = provider.options.apiKey
  if (typeof configured === "string" && configured.trim() !== "") return configured
  if (auth?.type === "api" && auth.key.trim() !== "") return auth.key
}

function configuredModels(provider: Provider.Info, config: NonNullable<ConfigV1.Info["provider"]>[string]) {
  const whitelist = config.whitelist ? new Set(config.whitelist) : undefined
  const blacklist = new Set(config.blacklist ?? [])
  const baseURL = validEndpoint(provider.options.baseURL)
  if (provider.options.baseURL !== undefined && !baseURL) return
  const modelIDs = Array.from(new Set([...Object.keys(config.models ?? {}), ...Object.keys(provider.models)]))
  const models = modelIDs.flatMap((modelID) => {
    const model = provider.models[modelID]
    if (!model) return []
    if (whitelist && !whitelist.has(model.id)) return []
    if (blacklist.has(model.id)) return []
    if (!responsesCompatibleSDKs.has(model.api.npm)) return []
    if (model.status === "deprecated") return []

    const endpoint = baseURL ?? validEndpoint(model.api.url)
    if (!endpoint) return []
    const efforts = reasoningEfforts(model)
    const defaultEffort = defaultReasoningEffort(model, efforts)
    return [
      {
        endpoint,
        model: {
          id: model.api.id,
          modelID: model.id,
          name: model.name,
          efforts,
          ...(defaultEffort ? { defaultEffort } : {}),
          ...(Number.isFinite(model.limit.context) && model.limit.context > 0
            ? { contextWindow: model.limit.context }
            : {}),
        } satisfies CodexProviders.Model,
      },
    ]
  })
  const endpoints = new Set(models.map((model) => model.endpoint))
  if (endpoints.size !== 1) return
  const seen = new Set<string>()
  return {
    baseURL: models[0].endpoint,
    items: models.flatMap((model) => {
      if (seen.has(model.model.id)) return []
      seen.add(model.model.id)
      return [model.model]
    }),
  }
}

function validEndpoint(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return
  const normalized = value.trim()
  try {
    const protocol = new URL(normalized).protocol
    if (protocol === "http:" || protocol === "https:") return normalized
  } catch {}
}

function reasoningEfforts(model: Provider.Model) {
  return Array.from(
    new Set(
      Object.values(model.variants ?? {}).flatMap((variant) => {
        const effort = variant.reasoningEffort
        return typeof effort === "string" && nativeEfforts.has(effort) ? [effort] : []
      }),
    ),
  )
}

function defaultReasoningEffort(model: Provider.Model, efforts: string[]) {
  const value = model.variants?.default?.reasoningEffort
  if (typeof value !== "string" || !nativeEfforts.has(value)) return
  if (!efforts.includes(value)) return
  return value
}
