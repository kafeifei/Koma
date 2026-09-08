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

const nativeEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
const responsesCompatibleSDKs = new Set(["@ai-sdk/openai", "@ai-sdk/openai-compatible"])

type ProviderConfig = NonNullable<ConfigV1.Info["provider"]>[string]
type ModelConfig = NonNullable<ProviderConfig["models"]>[string]

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

  return Object.entries(cfg.provider ?? {}).flatMap(([providerID, providerConfig]) => {
    if (enabled && !enabled.has(providerID)) return []
    if (disabled.has(providerID)) return []

    const baseURL = endpoint(providerConfig, catalog[providerID])
    if (!baseURL) return []
    const key = apiKey(providerConfig, credentials[providerID])
    if (!key) return []

    const models = configuredModels(providerConfig, catalog[providerID])
    if (models.length === 0) return []
    return [
      {
        key,
        provider: {
          id: providerID,
          name: providerConfig.name ?? catalog[providerID]?.name ?? providerID,
          baseURL,
          models,
        } satisfies CodexProviders.Provider,
      },
    ]
  })
}

function endpoint(provider: ProviderConfig, catalog: ModelsDev.Provider | undefined) {
  const value = provider.options?.baseURL ?? provider.api ?? catalog?.api
  if (typeof value !== "string" || value.trim() === "") return
  const normalized = value.trim()
  try {
    const protocol = new URL(normalized).protocol
    if (protocol === "http:" || protocol === "https:") return normalized
  } catch {}
}

function apiKey(provider: ProviderConfig, auth: Auth.Info | undefined) {
  const configured = provider.options?.apiKey
  if (typeof configured === "string" && configured.trim() !== "") return configured
  if (auth?.type === "api" && auth.key.trim() !== "") return auth.key
}

function configuredModels(provider: ProviderConfig, catalog: ModelsDev.Provider | undefined) {
  const whitelist = provider.whitelist ? new Set(provider.whitelist) : undefined
  const blacklist = new Set(provider.blacklist ?? [])
  const modelIDs = Array.from(new Set([...Object.keys(provider.models ?? {}), ...Object.keys(catalog?.models ?? {})]))
  const seen = new Set<string>()

  return modelIDs.flatMap((modelID) => {
    if (whitelist && !whitelist.has(modelID)) return []
    if (blacklist.has(modelID)) return []

    const configured = provider.models?.[modelID]
    const catalogModel = catalog?.models[configured?.id ?? modelID] ?? catalog?.models[modelID]
    const npm = configured?.provider?.npm ?? provider.npm ?? catalogModel?.provider?.npm ?? catalog?.npm
    // Codex calls the configured endpoint's Responses API directly. The SDK choice
    // only declares compatibility; gateways without Responses support fail normally.
    if (!responsesCompatibleSDKs.has(npm ?? "")) return []
    if ((configured?.status ?? catalogModel?.status) === "deprecated") return []

    const id = configured?.id ?? catalogModel?.id ?? modelID
    if (seen.has(id)) return []
    seen.add(id)
    const reasoning = configured?.reasoning ?? catalogModel?.reasoning ?? false
    const efforts = reasoning ? reasoningEfforts(configured, catalogModel) : []
    const defaultEffort = defaultReasoningEffort(configured, efforts)
    const contextWindow = configured?.limit?.context ?? catalogModel?.limit.context

    return [
      {
        id,
        name:
          configured?.name ?? (configured?.id && configured.id !== modelID ? modelID : (catalogModel?.name ?? modelID)),
        efforts,
        ...(defaultEffort ? { defaultEffort } : {}),
        ...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
          ? { contextWindow }
          : {}),
      },
    ]
  })
}

function reasoningEfforts(configured: ModelConfig | undefined, catalog: ModelsDev.Model | undefined) {
  const disabled = new Set(
    Object.entries(configured?.variants ?? {}).flatMap(([id, variant]) => (variant.disabled ? [id] : [])),
  )
  const fromCatalog =
    catalog?.reasoning_options
      ?.filter((option) => option.type === "effort")
      .flatMap((option) => option.values)
      .map((value) => (value === null ? "none" : value))
      .filter((value): value is string => nativeEfforts.has(value) && !disabled.has(value)) ?? []
  const explicit = Object.values(configured?.variants ?? {}).flatMap((variant) => {
    if (variant.disabled) return []
    return nativeEfforts.has(variant.reasoningEffort) ? [variant.reasoningEffort as string] : []
  })
  return Array.from(new Set([...fromCatalog, ...explicit]))
}

function defaultReasoningEffort(configured: ModelConfig | undefined, efforts: string[]) {
  const value = configured?.variants?.default?.reasoningEffort
  if (typeof value !== "string" || !nativeEfforts.has(value)) return
  if (configured?.variants?.default?.disabled || !efforts.includes(value)) return
  return value
}
