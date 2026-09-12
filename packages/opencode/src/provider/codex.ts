export * as CodexProvider from "./codex"

import { CodexProviders } from "@opencode-ai/codex/providers"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Effect, Layer } from "effect"
import { Auth } from "../auth"
import { OpenAIAuth } from "../auth/openai"
import { GlobalBus, type GlobalEvent } from "../bus/global"
import { EffectBridge } from "../effect/bridge"
import { Provider } from "./provider"
import { InstanceStore } from "../project/instance-store"

const nativeEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
const responsesCompatibleSDKs = new Set(["@ai-sdk/openai", "@ai-sdk/openai-compatible"])

export const node = makeGlobalNode({
  service: CodexProviders.Service,
  layer: Layer.effect(
    CodexProviders.Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const openaiAuth = yield* OpenAIAuth.Service
      const providerCatalog = yield* Provider.Service
      const instances = yield* InstanceStore.Service
      const bridge = yield* EffectBridge.make()

      const resolve = () =>
        Effect.gen(function* () {
          const catalog = yield* instances.provide({ directory: process.cwd() }, providerCatalog.list())
          const credentials = yield* auth.all()
          return configuredProviders(catalog, credentials)
        })

      return CodexProviders.Service.of({
        list: () => bridge.promise(resolve().pipe(Effect.map((providers) => providers.map((item) => item.provider)))),
        key: (providerID, baseURL, accountID) =>
          bridge.promise(
            resolve().pipe(
              Effect.flatMap((providers) =>
                Effect.promise(async () => {
                  const provider = providers.find((item) => item.provider.id === providerID)
                  if (provider?.provider.baseURL !== baseURL || provider.provider.accountID !== accountID) return
                  if (provider.oauth) {
                    const current = await openaiAuth.get()
                    if (current?.accountId !== accountID) return
                    return current?.access
                  }
                  return provider.key
                }),
              ),
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
  deps: [Auth.node, OpenAIAuth.node, Provider.node, InstanceStore.node],
})

function configuredProviders(catalog: Record<string, Provider.Info>, credentials: Record<string, Auth.Info>) {
  const providerIDs = Object.keys(catalog)
  // The Provider service already applies plugins, credentials, environment,
  // configuration, model aliases and visibility restrictions.
  const database = catalog

  return providerIDs.flatMap((providerID) => {
    const provider = database[providerID]
    if (!provider) return []
    const credential = credentials[providerID]
    const oauth = providerID === "openai" && credential?.type === "oauth"
    const resolved = oauth
      ? { ...provider, options: { ...provider.options, baseURL: "https://chatgpt.com/backend-api/codex" } }
      : provider
    const models = configuredModels(resolved)
    if (!models) return []
    const key = apiKey(provider, credentials[providerID])
    if (!key && !oauth) return []
    return [
      {
        key,
        oauth,
        provider: {
          id: provider.id,
          name: provider.name,
          baseURL: models.baseURL,
          ...(oauth && credential.accountId ? { accountID: credential.accountId } : {}),
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
  if (typeof provider.key === "string") return provider.key
}

function configuredModels(provider: Provider.Info) {
  const baseURL = validEndpoint(provider.options.baseURL)
  if (provider.options.baseURL !== undefined && !baseURL) return
  const modelIDs = Object.keys(provider.models)
  const models = modelIDs.flatMap((modelID) => {
    const model = provider.models[modelID]
    if (!model) return []
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
          ...(typeof model.options.serviceTier === "string" ? { serviceTier: model.options.serviceTier } : {}),
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
  const counts = new Map<string, number>()
  for (const item of models) counts.set(item.model.id, (counts.get(item.model.id) ?? 0) + 1)
  return {
    baseURL: models[0].endpoint,
    items: models.map(({ model }) => ({
      ...model,
      ...(model.modelID !== model.id && (counts.get(model.id)! > 1 || model.serviceTier)
        ? { executionID: model.modelID }
        : {}),
    })),
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
