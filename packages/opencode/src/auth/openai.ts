export * as OpenAIAuth from "./openai"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "."
import { makeCredentials } from "../plugin/openai/oauth"
import type { Credentials } from "../plugin/openai/oauth"

export class Service extends Context.Service<Service, Credentials>()("@opencode/OpenAIAuth") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      return makeCredentials({
        read: () => Effect.runPromise(auth.snapshot("openai")),
        commit: (expected, info) => Effect.runPromise(auth.compareAndSet("openai", expected, info)),
      })
    }),
  ),
  deps: [Auth.node],
})
