import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Credential } from "@opencode/core/credential"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { OpenAICompatibleDiscovery } from "@opencode/core/plugin/provider/openai-compatible-discovery"
import { Provider } from "@opencode/core/provider"
import { Document, Info } from "@opencode/schema/config"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eventually } from "../lib/eventually"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)

const addPlugins = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  yield* OpenAICompatibleDiscovery.Plugin.effect(yield* PluginHost.make(plugin, "discovery"))
  yield* ConfigProviderPlugin.Plugin.effect(yield* PluginHost.make(plugin, "config"))
})

const configuration = (providerID: string, baseURL: string) =>
  new Document({
    type: "document",
    info: decode({
      providers: {
        [providerID]: {
          name: "Gateway",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL, apiKey: "secret" },
          models: { listed: { name: "Listed in config", limit: { context: 4096 } } },
        },
      },
    }),
  })

describe("OpenAICompatibleDiscovery", () => {
  it.live("adds the models the endpoint lists and keeps the last list through an outage", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { requests: [] as { authorization: string | null; path: string }[], down: false, extra: "extra" }

        return {
          state,
          server: Bun.serve({
            port: 0,
            fetch: (request) => {
              state.requests.push({
                authorization: request.headers.get("authorization"),
                path: new URL(request.url).pathname,
              })

              if (state.down) return new Response("unavailable", { status: 503 })

              return Response.json({
                object: "list",
                data: [
                  { id: "listed", object: "model", context_length: 131_072 },
                  { id: state.extra, object: "model", context_length: 65_536 },
                  { id: "no-limit", object: "model" },
                ],
              })
            },
          }),
        }
      }),
      ({ state, server }) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const models = yield* Model.Service
          const config = yield* Config.Test
          // Unique per run: the plugin shares its inventory between Locations of one process.
          const providerID = Provider.ID.make(`gateway-${server.port}`)
          const switched = bus.publish(Credential.Event.Switched, {
            integrationID: providerID,
            credentialID: Credential.ID.make("cred_test"),
          })

          expect(ProviderPlugins.map((item) => item.id)).toContain("koma.provider.openai-compatible-discovery")
          yield* config.setEntries([configuration(providerID, `${server.url.origin}/proxy/v1/`)])
          yield* addPlugins()

          const extra = yield* eventually(models.get(providerID, Model.ID.make("extra")), (item) => item !== undefined)

          expect(state.requests).toContainEqual({ authorization: "Bearer secret", path: "/proxy/v1/models" })
          expect(extra).toMatchObject({
            modelID: "extra",
            name: "extra",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            limit: { context: 65_536 },
          })
          expect(yield* models.get(providerID, Model.ID.make("no-limit"))).toMatchObject({ limit: { context: 200_000 } })
          // Config still owns the models it lists.
          expect(yield* models.get(providerID, Model.ID.make("listed"))).toMatchObject({
            name: "Listed in config",
            limit: { context: 4096 },
          })

          state.extra = "renamed"
          yield* switched
          yield* eventually(models.get(providerID, Model.ID.make("renamed")), (item) => item !== undefined)
          expect(yield* models.get(providerID, Model.ID.make("extra"))).toBeUndefined()

          const before = state.requests.length

          state.down = true
          yield* switched
          yield* eventually(
            Effect.sync(() => state.requests.length),
            (count) => count > before,
          )
          yield* Effect.promise(() => Bun.sleep(20))
          expect(yield* models.get(providerID, Model.ID.make("renamed"))).toBeDefined()
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )
})
