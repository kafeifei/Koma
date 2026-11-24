export * as OpenAICompatibleDiscovery from "./openai-compatible-discovery.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Document, Entry } from "@opencode/schema/config"
import { ProviderDiscovery } from "@opencode/schema/provider-discovery"
import { Effect, FiberSet, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { Credential } from "../../credential.js"
import { Model } from "../../model.js"
import type { PluginInternal } from "../internal.js"
import { foldSettings } from "./configured.js"
import { activeCredential } from "./credential-settings.js"

// Koma: a provider that config adds with the OpenAI-compatible package lists only the models config names. Its
// endpoint knows what it serves, so this plugin reads `<baseURL>/models` and adds what config left out. It reads at
// startup, when config or the provider's credential changes, and on the `refresh` RPC; it does not poll.

const packages = new Set([
  "@opencode/ai/providers/openai-compatible",
  "@opencode/ai/providers/openai-compatible/responses",
])

const requestTimeout = "15 seconds"

const Limit = Schema.optional(Schema.NullOr(Schema.Number))

// The OpenAI list shape, plus the context fields gateways and runtimes commonly add.
const RemoteModel = Schema.Struct({
  id: Schema.String,
  context_length: Limit,
  context_window: Limit,
  max_model_len: Limit,
})

const Response = Schema.Struct({ data: Schema.Array(RemoteModel) })

type Target = { readonly providerID: string; readonly url: string; readonly apiKey: string | undefined }

type Found = { readonly id: string; readonly context: number | undefined }

// Every Location runs its own copy of the plugin. They share one inventory and reload together, so a refresh asked
// for in one Location shows in all of them.
const inventory = new Map<string, { readonly url: string; readonly models: readonly Found[] }>()
const reloads = new Set<Effect.Effect<void>>()
const lock = Semaphore.makeUnsafe(1)

export const Plugin = define({
  id: "koma.provider.openai-compatible-discovery",
  effect: Effect.fn(function* (ctx) {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const source = { targets: targets(yield* config.entries()) }

    yield* ctx.provider.transform((providers) => {
      for (const target of source.targets) {
        const found = inventory.get(target.providerID)

        if (!found || found.url !== target.url) continue
        const known = providers.get(target.providerID)?.models
        // Config applies after this transform and names, limits and enables the provider and the models it lists.
        providers.update(target.providerID, () => {})
        for (const item of found.models) {
          if (known?.has(item.id)) continue
          providers.models.update(target.providerID, item.id, (model) => {
            model.modelID = Model.ID.make(item.id)
            model.name = item.id
            model.capabilities = { tools: true, input: ["text", "image"], output: ["text"] }
            if (item.context) model.limit.context = item.context
          })
        }
      }
    })

    const list = Effect.fn("OpenAICompatibleDiscovery.list")(function* (target: Target) {
      // A key saved with /connect or set in the provider's env var wins over config, as it does for requests.
      const active = yield* activeCredential(ctx, target.providerID)
      const apiKey = active.credential?.type === "key" ? active.credential.key : target.apiKey
      const request = HttpClientRequest.get(`${target.url}/models`).pipe(HttpClientRequest.acceptJson)
      const response = yield* http
        .execute(apiKey ? request.pipe(HttpClientRequest.bearerToken(apiKey)) : request)
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)), Effect.timeout(requestTimeout))

      return response.data
        .filter((model) => model.id.length > 0)
        .map((model): Found => {
          const context = model.context_length ?? model.context_window ?? model.max_model_len ?? undefined

          return { id: model.id, context: context && context > 0 ? context : undefined }
        })
        .toSorted((a, b) => a.id.localeCompare(b.id))
    })

    // A failed read keeps the provider's last list, so an outage does not take its models away.
    const refresh = Effect.fn("OpenAICompatibleDiscovery.refresh")(function* (only?: (target: Target) => boolean) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const results = yield* Effect.forEach(
            source.targets.filter((target) => !only || only(target)),
            (target) =>
              list(target).pipe(
                Effect.map((models): ProviderDiscovery.Result => {
                  inventory.set(target.providerID, { url: target.url, models })

                  return { providerID: target.providerID, models: models.length }
                }),
                Effect.catch((cause) =>
                  Effect.logWarning("failed to list an OpenAI-compatible provider's models", {
                    providerID: target.providerID,
                    baseURL: target.url,
                    cause,
                  }).pipe(
                    Effect.as<ProviderDiscovery.Result>({
                      providerID: target.providerID,
                      error: cause instanceof Error ? cause.message : String(cause),
                    }),
                  ),
                ),
              ),
            { concurrency: "unbounded" },
          )

          if (results.length > 0) yield* Effect.forEach([...reloads], (reload) => reload, { discard: true })

          return results
        }),
      )
    })

    const reload = ctx.provider.reload()

    reloads.add(reload)

    yield* Effect.addFinalizer(() => Effect.sync(() => reloads.delete(reload)))

    yield* ctx.rpc
      .register(ProviderDiscovery.Definition, {
        refresh: () => refresh().pipe(Effect.map((providers) => ({ providers }))),
      })
      .pipe(Effect.orDie)

    const background = yield* FiberSet.make()
    const missing = (target: Target) => inventory.get(target.providerID)?.url !== target.url

    // Another Location may already have read these lists; only the ones still missing are fetched here.
    yield* FiberSet.run(background, refresh(missing))

    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => source.targets.some((target) => target.providerID === event.data.integrationID)),
      Stream.runForEach((event) =>
        FiberSet.run(
          background,
          refresh((target) => target.providerID === event.data.integrationID),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.event.subscribe({ types: ["config.updated"] }).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = targets(yield* config.entries())

          if (JSON.stringify(next) === JSON.stringify(source.targets)) return
          source.targets = next
          yield* reload
          yield* FiberSet.run(background, refresh(missing))
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

/** The providers config declares with the OpenAI-compatible package and an http(s) `baseURL`. */
function targets(entries: readonly Entry[]): Target[] {
  const ids = new Set(
    entries
      .filter((entry): entry is Document => entry.type === "document")
      .flatMap((entry) => Object.entries(entry.info.providers ?? {}))
      .filter(([, provider]) => provider.package !== undefined && packages.has(provider.package))
      .map(([id]) => id),
  )

  return [...ids].toSorted().flatMap((providerID) => {
    const settings = foldSettings(entries, providerID, undefined)
    const baseURL = typeof settings?.baseURL === "string" ? settings.baseURL.replace(/\/+$/, "") : ""

    if (!URL.canParse(baseURL) || !/^https?:$/.test(new URL(baseURL).protocol)) return []

    return [{ providerID, url: baseURL, apiKey: typeof settings?.apiKey === "string" ? settings.apiKey : undefined }]
  })
}
