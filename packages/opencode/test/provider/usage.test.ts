import { expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Auth } from "../../src/auth"
import { OpenAIAuth } from "../../src/auth/openai"
import { ProviderUsage } from "../../src/provider/usage"
import { testEffect } from "../lib/effect"

test("keeps real zero values and actual windows without inventing a second limit", () => {
  expect(
    ProviderUsage.fromOpenAI({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1789805378 },
        secondary_window: null,
      },
      credits: { balance: "0", unlimited: false },
    }),
  ).toEqual({
    providerID: "openai",
    plan: "pro",
    credits: 0,
    windows: [{ id: "usage.primary_window", usedPercent: 0, durationSeconds: 604800, resetsAt: 1789805378000 }],
  })
})

test("omits absent or invalid fields and empty responses", () => {
  for (const value of [
    null,
    [],
    {},
    { credits: { balance: null } },
    { credits: { balance: "" } },
    { rate_limit: { primary_window: { used_percent: NaN, reset_at: 0 } } },
  ]) {
    expect(ProviderUsage.fromOpenAI(value)).toBeNull()
  }
  expect(
    ProviderUsage.fromOpenAI({ rate_limit: { primary_window: { used_percent: 23 } }, credits: { unlimited: true } }),
  ).toEqual({
    providerID: "openai",
    windows: [{ id: "usage.primary_window", usedPercent: 23 }],
    unlimitedCredits: true,
  })
})

test("preserves additional named limits and reset-only data", () => {
  expect(
    ProviderUsage.fromOpenAI({
      additional_rate_limits: [
        {
          limit_name: "Astra",
          rate_limit: {
            secondary_window: { reset_at: 1789805378 },
          },
        },
      ],
    })?.windows,
  ).toEqual([{ id: "additional.0.secondary_window", name: "Astra", resetsAt: 1789805378000 }])
})

function fixture() {
  const state = {
    credential: new Auth.Oauth({
      type: "oauth",
      access: "private-access",
      refresh: "private-refresh",
      accountId: "account",
      expires: Date.now() + 60000,
    }) as Auth.Info | undefined,
    revision: 1,
    status: 200,
    requests: 0,
    switchAccount: false,
  }
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      state.requests++
      expect(request.url).toBe("https://chatgpt.com/backend-api/wham/usage")
      expect(request.headers.authorization).toBe("Bearer private-access")
      expect(request.headers["chatgpt-account-id"]).toBe("account")
      expect(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).toEqual(
        Option.some({ redirect: "error", cache: "no-store" }),
      )
      if (state.switchAccount) state.revision++
      return HttpClientResponse.fromWeb(request, Response.json({ plan_type: "pro" }, { status: state.status }))
    }),
  )
  const layer = LayerNode.compile(ProviderUsage.node, [
    [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
    [
      Auth.node,
      Layer.mock(Auth.Service, {
        snapshot: () => Effect.sync(() => ({ info: state.credential, revision: state.revision })),
      }),
    ],
    [
      OpenAIAuth.node,
      Layer.succeed(OpenAIAuth.Service, {
        get: async () => (state.credential?.type === "oauth" ? state.credential : undefined),
      }),
    ],
  ])
  return { state, it: testEffect(layer) }
}

const supported = fixture()
supported.it.live("returns shared Provider usage without exposing credentials", () =>
  Effect.gen(function* () {
    const usage = yield* (yield* ProviderUsage.Service).read("openai")
    expect(usage).toEqual({ providerID: "openai", plan: "pro", windows: [] })
    expect(JSON.stringify(usage)).not.toContain("private-")
    expect(supported.state.requests).toBe(1)
  }),
)

const unsupported = fixture()
unsupported.it.live("never sends another Provider's or an API key's credentials to ChatGPT", () =>
  Effect.gen(function* () {
    const usage = yield* ProviderUsage.Service
    expect(yield* usage.read("xd")).toBeNull()
    unsupported.state.credential = new Auth.Api({ type: "api", key: "private-key" })
    expect(yield* usage.read("openai")).toBeNull()
    expect(unsupported.state.requests).toBe(0)
  }),
)

const stale = fixture()
stale.it.live("discards responses after an account selection changes", () =>
  Effect.gen(function* () {
    stale.state.switchAccount = true
    expect(yield* (yield* ProviderUsage.Service).read("openai")).toBeNull()
  }),
)

const failure = fixture()
failure.it.live("treats upstream failures as unavailable without returning the upstream body", () =>
  Effect.gen(function* () {
    failure.state.status = 429
    expect(yield* (yield* ProviderUsage.Service).read("openai")).toBeNull()
  }),
)
