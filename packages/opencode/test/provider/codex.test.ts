import { expect } from "bun:test"
import { CodexProviders } from "@opencode-ai/codex/providers"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { OpenAIAuth } from "../../src/auth/openai"
import { GlobalBus } from "../../src/bus/global"
import { InstanceStore } from "../../src/project/instance-store"
import { Provider } from "../../src/provider/provider"
import { CodexProvider } from "../../src/provider/codex"
import { testEffect } from "../lib/effect"

function fixture() {
  const state = {
    catalog: {} as Record<string, Provider.Info>,
    auth: {} as Record<string, Auth.Info>,
    listeners: new Set<() => void>(),
  }
  const layer = LayerNode.compile(CodexProvider.node, [
    [Provider.node, Layer.mock(Provider.Service, { list: () => Effect.succeed(state.catalog) })],
    [InstanceStore.node, Layer.mock(InstanceStore.Service, { provide: (_input, effect) => effect })],
    [
      OpenAIAuth.node,
      Layer.succeed(OpenAIAuth.Service, {
        get: async () => (state.auth.openai?.type === "oauth" ? state.auth.openai : undefined),
      }),
    ],
    [
      Auth.node,
      Layer.mock(Auth.Service, {
        all: () => Effect.succeed(state.auth),
        onSelection: (listener) =>
          Effect.sync(() => {
            const notify = () => listener("openai")
            state.listeners.add(notify)
            return () => state.listeners.delete(notify)
          }),
      }),
    ],
  ])
  return { state, it: testEffect(layer) }
}
function catalog() {
  return Provider.applyConfiguredProviders(
    {},
    {
      openai: {
        name: "Existing OpenAI",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://api.example.test/v1" },
        models: {
          normal: { id: "wire", name: "Normal", limit: { context: 400000, output: 32000 } },
          fast: {
            id: "wire",
            name: "Fast",
            options: { serviceTier: "priority" },
            limit: { context: 400000, output: 32000 },
          },
        },
      },
    },
    {},
  )
}
const listing = fixture()
listing.it.live("preserves final Provider aliases, names and Fast settings without rebuilding the catalog", () =>
  Effect.gen(function* () {
    listing.state.catalog = catalog()
    listing.state.auth = { openai: new Auth.Api({ type: "api", key: "provider-key" }) }
    const service = yield* CodexProviders.Service
    const providers = yield* Effect.promise(() => service.list())
    expect(providers[0]?.name).toBe("Existing OpenAI")
    expect(
      providers[0]?.models.map((model) => ({
        id: model.id,
        modelID: model.modelID,
        executionID: model.executionID,
        tier: model.serviceTier,
      })),
    ).toEqual([
      { id: "wire", modelID: "normal", executionID: "normal", tier: undefined },
      { id: "wire", modelID: "fast", executionID: "fast", tier: "priority" },
    ])
    expect(JSON.stringify(providers)).not.toContain("provider-key")
    // A catalog removal must disappear; the adapter must not resurrect it from models.dev.
    delete listing.state.catalog.openai.models.fast
    expect((yield* Effect.promise(() => service.list()))[0]?.models.map((model) => model.modelID)).toEqual(["normal"])
    listing.state.catalog = {}
    expect(yield* Effect.promise(() => service.list())).toEqual([])
  }),
)
const credentials = fixture()
credentials.it.live("resolves current Provider credentials and rejects endpoint or account changes", () =>
  Effect.gen(function* () {
    credentials.state.catalog = catalog()
    credentials.state.auth = { openai: new Auth.Api({ type: "api", key: "first" }) }
    const service = yield* CodexProviders.Service
    expect(yield* Effect.promise(() => service.key("openai", "https://api.example.test/v1"))).toBe("first")
    credentials.state.auth.openai = new Auth.Api({ type: "api", key: "second" })
    expect(yield* Effect.promise(() => service.key("openai", "https://api.example.test/v1"))).toBe("second")
    credentials.state.catalog.openai.options.baseURL = "https://other.example.test/v1"
    expect(yield* Effect.promise(() => service.key("openai", "https://api.example.test/v1"))).toBeUndefined()
    credentials.state.auth.openai = new Auth.Oauth({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 3600000,
      accountId: "account-1",
    })
    const providers = yield* Effect.promise(() => service.list())
    expect(providers[0]?.models).toHaveLength(2)
    expect(providers[0]?.baseURL).toBe("https://chatgpt.com/backend-api/codex")
    expect(yield* Effect.promise(() => service.key("openai", providers[0]!.baseURL, "account-1"))).toBe("access")
    expect(yield* Effect.promise(() => service.key("openai", providers[0]!.baseURL, "account-2"))).toBeUndefined()
    credentials.state.catalog = {}
    expect(yield* Effect.promise(() => service.key("openai", providers[0]!.baseURL, "account-1"))).toBeUndefined()
  }),
)
const protocols = fixture()
protocols.it.live("does not advertise unsupported protocols or invalid endpoints", () =>
  Effect.gen(function* () {
    protocols.state.catalog = catalog()
    protocols.state.auth = { openai: new Auth.Api({ type: "api", key: "key" }) }
    const service = yield* CodexProviders.Service
    protocols.state.catalog.openai.models.fast.api.npm = "@ai-sdk/anthropic"
    expect((yield* Effect.promise(() => service.list()))[0]?.models.map((model) => model.modelID)).toEqual(["normal"])
    protocols.state.catalog.openai.options.baseURL = "file:///tmp/models"
    expect(yield* Effect.promise(() => service.list())).toEqual([])
  }),
)
const changes = fixture()
changes.it.live("notifies on Provider selection and config changes until unsubscribed", () =>
  Effect.gen(function* () {
    const service = yield* CodexProviders.Service
    let calls = 0
    const off = service.onChange(() => calls++)
    changes.state.listeners.forEach((listener) => listener())
    GlobalBus.emit("event", { directory: "global", payload: { type: "global.disposed", properties: {} } })
    expect(calls).toBe(2)
    off()
    changes.state.listeners.forEach((listener) => listener())
    expect(calls).toBe(2)
  }),
)
