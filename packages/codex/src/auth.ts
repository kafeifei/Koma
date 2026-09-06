export * as CodexAuth from "./auth"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

export type Tokens = { accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }
export interface Interface {
  readonly get: (previous?: Tokens) => Promise<Tokens | undefined>
  readonly onSelection: (listener: () => void) => () => void
}
export class Service extends Context.Service<Service, Interface>()("@opencode/CodexAuth") {}

// Standalone V2 owns a different credential store. Only a host with an explicit
// binding may supply credentials; the default keeps native managed login.
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.succeed(Service, { get: async () => undefined, onSelection: () => () => {} }),
  deps: [],
})
