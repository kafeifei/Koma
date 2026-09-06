export * as CodexCredentials from "./codex"

import { CodexAuth } from "@opencode-ai/codex/auth"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Effect, Layer } from "effect"
import { Auth } from "."
import { OpenAIAuth } from "./openai"
import { accountId } from "../plugin/openai/oauth"

export const node = makeGlobalNode({
  service: CodexAuth.Service,
  layer: Layer.effect(
    CodexAuth.Service,
    Effect.gen(function* () {
      const credentials = yield* OpenAIAuth.Service
      const auth = yield* Auth.Service
      return CodexAuth.Service.of({
        get: async (previous) => {
          const value = await credentials.get(
            previous && {
              accessToken: previous.accessToken,
              accountId: previous.chatgptAccountId,
            },
          )
          if (!value) return
          const account = accountId(value)
          if (!account) return
          if (previous && previous.chatgptAccountId !== account) throw new Error("OpenAI account selection changed")
          return { accessToken: value.access, chatgptAccountId: account, chatgptPlanType: null }
        },
        onSelection: (listener) =>
          Effect.runSync(
            auth.onSelection((key) => {
              if (key === "openai") listener()
            }),
          ),
      })
    }),
  ),
  deps: [OpenAIAuth.node, Auth.node],
})
