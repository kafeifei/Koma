import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CodexAuth } from "@opencode-ai/codex/auth"
import { Auth } from "../../src/auth"
import { OpenAIAuth } from "../../src/auth/openai"
import { CodexCredentials } from "../../src/auth/codex"
import { Plugin } from "../../src/plugin"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { makeCredentials } from "../../src/plugin/openai/oauth"

const token = (account: string) =>
  `fixture.${Buffer.from(JSON.stringify({ chatgpt_account_id: account })).toString("base64url")}.signature`
const selected: Auth.Oauth = {
  type: "oauth",
  access: token("fixture-account"),
  refresh: "fixture-refresh",
  expires: 0,
  accountId: "fixture-account",
}

describe("OpenAI credential ownership", () => {
  test("the production HTTP composition accepts the native auth replacement", async () => {
    const { Server } = await import("../../src/server/server")
    const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const response = await fetch(new URL("/global/health", server.url))
      expect(response.status).toBe(200)
    } finally {
      await server.stop(true)
    }
  })

  test("separately built provider and native graphs share the production auth and refresh owner", async () => {
    const memoMap = Layer.makeMemoMapUnsafe()
    const provider = ManagedRuntime.make(
      AppNodeBuilderV1.build(LayerNode.group([Plugin.node, Auth.node, OpenAIAuth.node])),
      { memoMap },
    )
    const native = ManagedRuntime.make(
      AppNodeBuilderV1.build(LayerNode.group([CodexCredentials.node, Auth.node, OpenAIAuth.node])),
      { memoMap },
    )
    try {
      const a = await provider.runPromise(
        Effect.gen(function* () {
          return { auth: yield* Auth.Service, credentials: yield* OpenAIAuth.Service }
        }),
      )
      const b = await native.runPromise(
        Effect.gen(function* () {
          return { auth: yield* Auth.Service, credentials: yield* OpenAIAuth.Service }
        }),
      )
      expect(a.auth).toBe(b.auth)
      expect(a.credentials).toBe(b.credentials)
      await provider.runPromise(a.auth.set("openai", selected))
      const snapshot = await native.runPromise(b.auth.snapshot("openai"))
      await provider.runPromise(a.auth.remove("openai"))
      expect(await native.runPromise(b.auth.compareAndSet("openai", snapshot, selected))).toBe(false)
    } finally {
      await native.dispose()
      await provider.dispose()
    }
  })

  test("the provider fetch and native refresh port share one HTTP refresh and conditional write", async () => {
    let calls = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/oauth/token") return Response.json({})
        calls++
        await gate
        return Response.json({
          access_token: token("fixture-account"),
          refresh_token: "fixture-rotated",
          expires_in: 3600,
        })
      },
    })
    const memoMap = Layer.makeMemoMapUnsafe()
    const owner = Layer.effect(
      OpenAIAuth.Service,
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return makeCredentials(
          {
            read: () => Effect.runPromise(auth.snapshot("openai")),
            commit: (snapshot, value) => Effect.runPromise(auth.compareAndSet("openai", snapshot, value)),
          },
          server.url.origin,
        )
      }),
    )
    const replacement = LayerNode.make({ service: OpenAIAuth.Service, layer: owner, deps: [Auth.node] })
    const provider = ManagedRuntime.make(
      AppNodeBuilderV1.build(LayerNode.group([Auth.node, OpenAIAuth.node]), [[OpenAIAuth.node, replacement]]),
      { memoMap },
    )
    const native = ManagedRuntime.make(
      AppNodeBuilderV1.build(LayerNode.group([CodexCredentials.node, Auth.node]), [[OpenAIAuth.node, replacement]]),
      { memoMap },
    )
    try {
      const auth = await provider.runPromise(Auth.Service)
      await provider.runPromise(auth.set("openai", selected))
      const credentials = await provider.runPromise(OpenAIAuth.Service)
      const port = await native.runPromise(CodexAuth.Service)
      const hooks = await CodexAuthPlugin({} as never, { credentials, codexApiEndpoint: server.url.toString() })
      const loaded = await hooks.auth!.loader!(async () => selected, {} as never)
      const fetch = loaded.fetch!("https://api.openai.com/v1/responses")
      const refresh = port.get({
        accessToken: selected.access,
        chatgptAccountId: "fixture-account",
        chatgptPlanType: null,
      })
      const deadline = Date.now() + 5000
      while (!calls && Date.now() < deadline) await Bun.sleep(5)
      expect(calls).toBe(1)
      release()
      await Promise.all([fetch, refresh])
      expect(calls).toBe(1)
      const final = await provider.runPromise(auth.snapshot("openai"))
      expect(final.info?.type === "oauth" && final.info.refresh).toBe("fixture-rotated")
    } finally {
      release()
      await native.dispose()
      await provider.dispose()
    }
  })

  test("logout during HTTP refresh rejects the response and leaves the store empty", async () => {
    let info: Auth.Info | undefined = selected
    let revision = 0
    let release = () => {}
    let started = () => {}
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    using server = Bun.serve({
      port: 0,
      async fetch() {
        started()
        await gate
        return Response.json({ access_token: token("fixture-account"), refresh_token: "fixture-rotated" })
      },
    })
    const credentials = makeCredentials(
      {
        read: async () => ({ info, revision }),
        commit: async (snapshot, value) => {
          if (snapshot.revision !== revision) return false
          info = value
          return true
        },
      },
      server.url.origin,
    )
    const pending = credentials.get()
    await ready
    info = undefined
    revision++
    release()
    const error = await pending.catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error && error.message).toContain("authentication changed")
    expect(info).toBeUndefined()
  })
})
