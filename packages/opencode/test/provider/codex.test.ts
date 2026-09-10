import { expect } from "bun:test"
import { CodexProviders } from "@opencode-ai/codex/providers"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { GlobalBus } from "../../src/bus/global"
import { Config } from "../../src/config/config"
import { CodexProvider } from "../../src/provider/codex"
import { testEffect } from "../lib/effect"

function fixture() {
  const state: {
    config: ConfigV1.Info
    auth: Record<string, Auth.Info>
    catalog: Record<string, ModelsDev.Provider>
    authListeners: Set<(providerID: string) => void>
  } = {
    config: {},
    auth: {},
    catalog: {},
    authListeners: new Set(),
  }
  const layer = LayerNode.compile(CodexProvider.node, [
    [
      Config.node,
      Layer.mock(Config.Service, {
        getGlobal: () => Effect.succeed(state.config),
      }),
    ],
    [
      Auth.node,
      Layer.mock(Auth.Service, {
        all: () => Effect.succeed(state.auth),
        onSelection: (listener) =>
          Effect.sync(() => {
            state.authListeners.add(listener)
            return () => state.authListeners.delete(listener)
          }),
      }),
    ],
    [
      ModelsDev.node,
      Layer.mock(ModelsDev.Service, {
        get: () => Effect.succeed(state.catalog),
      }),
    ],
  ])
  return { state, it: testEffect(layer) }
}

const listing = fixture()

listing.it.live("lists only configured API-key Responses providers and applies model overrides", () =>
  Effect.gen(function* () {
    listing.state.auth = {
      xd: new Auth.Api({ type: "api", key: "secret-xd" }),
      oauth: new Auth.Oauth({ type: "oauth", access: "access", refresh: "refresh", expires: 1 }),
      disabled: new Auth.Api({ type: "api", key: "secret-disabled" }),
      chat: new Auth.Api({ type: "api", key: "secret-chat" }),
      local: new Auth.Api({ type: "api", key: "secret-local" }),
      split: new Auth.Api({ type: "api", key: "secret-split" }),
      "not-enabled": new Auth.Api({ type: "api", key: "secret-not-enabled" }),
    }
    listing.state.config = {
      enabled_providers: ["xd", "configured", "oauth", "disabled", "chat", "local", "split"],
      disabled_providers: ["disabled"],
      provider: {
        xd: {
          name: "XD Gateway",
          npm: "@ai-sdk/openai",
          whitelist: ["gpt", "gpt-alias", "alias", "chat", "blocked"],
          blacklist: ["blocked"],
          options: { baseURL: "https://xd.example.test/v1" },
          models: {
            gpt: {
              name: "Configured GPT",
              reasoning: true,
              limit: { context: 421_053, output: 32_000 },
              variants: {
                default: { reasoningEffort: "low" },
                high: { disabled: true },
                extra: { reasoningEffort: "xhigh" },
                invalid: { reasoningEffort: "extreme" },
              },
            },
            alias: { id: "gpt-alias", reasoning: false },
            chat: { provider: { npm: "@ai-sdk/anthropic" } },
            blocked: {},
          },
        },
        oauth: {
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://oauth.example.test/v1" },
          models: { gpt: {} },
        },
        disabled: {
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://disabled.example.test/v1" },
          models: { gpt: {} },
        },
        chat: {
          npm: "@ai-sdk/anthropic",
          options: { baseURL: "https://chat.example.test/v1" },
          models: { claude: {} },
        },
        local: {
          npm: "@ai-sdk/openai",
          options: { baseURL: "file:///tmp/models" },
          models: { gpt: { provider: { api: "https://must-not-fallback.example.test/v1" } } },
        },
        split: {
          npm: "@ai-sdk/openai",
          models: {
            first: { provider: { api: "https://first.example.test/v1" } },
            second: { provider: { api: "https://second.example.test/v1" } },
          },
        },
        configured: {
          name: "Config key",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://configured.example.test/v1", apiKey: "secret-configured" },
          models: { gpt: { name: "Configured only" } },
        },
        "not-enabled": {
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://not-enabled.example.test/v1" },
          models: { gpt: {} },
        },
      },
    }
    listing.state.catalog = {
      xd: {
        id: "xd",
        name: "Catalog XD",
        env: [],
        npm: "@ai-sdk/openai",
        models: {
          gpt: {
            id: "gpt",
            name: "Catalog GPT",
            release_date: "2026-01-01",
            attachment: true,
            reasoning: true,
            temperature: false,
            tool_call: true,
            reasoning_options: [{ type: "effort", values: [null, "low", "high", "extreme"] }],
            limit: { context: 100_000, output: 32_000 },
          },
          "gpt-alias": {
            id: "gpt-alias",
            name: "Catalog alias target",
            release_date: "2026-01-01",
            attachment: true,
            reasoning: true,
            temperature: false,
            tool_call: true,
            reasoning_options: [{ type: "effort", values: ["low", "medium"] }],
            limit: { context: 200_000, output: 32_000 },
          },
        },
      },
    }

    const service = yield* CodexProviders.Service
    const providers = yield* Effect.promise(() => service.list())

    expect(providers).toEqual([
      {
        id: "xd",
        name: "XD Gateway",
        baseURL: "https://xd.example.test/v1",
        models: [
          {
            id: "gpt",
            modelID: "gpt",
            name: "Configured GPT",
            efforts: ["none", "low", "xhigh"],
            defaultEffort: "low",
            contextWindow: 421_053,
          },
          {
            id: "gpt-alias",
            modelID: "alias",
            name: "alias",
            efforts: ["low", "medium"],
            contextWindow: 200_000,
          },
        ],
      },
      {
        id: "configured",
        name: "Config key",
        baseURL: "http://configured.example.test/v1",
        models: [{ id: "gpt", modelID: "gpt", name: "Configured only", efforts: [] }],
      },
    ])
    expect(JSON.stringify(providers)).not.toContain("secret-xd")
    expect(JSON.stringify(providers)).not.toContain("secret-configured")
  }),
)

const credentials = fixture()

credentials.it.live("resolves credentials live and fails closed when the endpoint or eligibility changes", () =>
  Effect.gen(function* () {
    credentials.state.config = {
      provider: {
        xd: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://one.example.test/v1" },
          models: { gpt: {} },
        },
      },
    }
    credentials.state.auth = { xd: new Auth.Api({ type: "api", key: "first" }) }
    const service = yield* CodexProviders.Service

    expect(yield* Effect.promise(() => service.key("xd", "https://one.example.test/v1"))).toBe("first")
    credentials.state.config.provider!.xd.options!.apiKey = "configured"
    expect(yield* Effect.promise(() => service.key("xd", "https://one.example.test/v1"))).toBe("configured")
    delete credentials.state.config.provider!.xd.options!.apiKey
    credentials.state.auth.xd = new Auth.Api({ type: "api", key: "second" })
    expect(yield* Effect.promise(() => service.key("xd", "https://one.example.test/v1"))).toBe("second")

    credentials.state.config.provider!.xd.options!.baseURL = "https://two.example.test/v1"
    expect(yield* Effect.promise(() => service.key("xd", "https://one.example.test/v1"))).toBeUndefined()
    expect(yield* Effect.promise(() => service.key("xd", "https://two.example.test/v1"))).toBe("second")

    credentials.state.config.disabled_providers = ["xd"]
    expect(yield* Effect.promise(() => service.key("xd", "https://two.example.test/v1"))).toBeUndefined()
  }),
)

const changes = fixture()

changes.it.live("notifies for auth selection and global config disposal until unsubscribed", () =>
  Effect.gen(function* () {
    const service = yield* CodexProviders.Service
    let calls = 0
    const unsubscribe = service.onChange(() => calls++)

    changes.state.authListeners.forEach((listener) => listener("xd"))
    GlobalBus.emit("event", { directory: "global", payload: { type: "global.disposed", properties: {} } })
    expect(calls).toBe(2)

    unsubscribe()
    changes.state.authListeners.forEach((listener) => listener("xd"))
    GlobalBus.emit("event", { directory: "global", payload: { type: "global.disposed", properties: {} } })
    expect(calls).toBe(2)
  }),
)
