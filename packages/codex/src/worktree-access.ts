export * as CodexWorktreeAccess from "./worktree-access"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Node, makeGlobalNode } from "@opencode-ai/core/effect/app-node"

type Target = { directory: string; sessionID: string }

export interface Interface {
  readonly claim: (input: Target) => Effect.Effect<unknown, unknown>
  readonly acquire: (input: Target) => Effect.Effect<void, unknown>
  readonly release: (input: Target) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodexWorktreeAccess") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

// Standalone V2 servers do not own the legacy Lab worktree archiver.
// The desktop's default backend must bind its real lifecycle service instead.
export const unmanagedNode = makeGlobalNode({
  service: Service,
  layer: Layer.succeed(Service, Service.of({
    claim: () => Effect.succeed(false),
    acquire: () => Effect.void,
    release: () => Effect.void,
  })),
  deps: [],
})
