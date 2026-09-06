export * as DirectoryLease from "./directory-lease"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("DirectoryLease.UnavailableError", {
  directory: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  /** Acquire before using a directory. The returned release is bound to that acquisition and is idempotent. */
  readonly acquire: (input: {
    readonly directory: string
    readonly ownerID: string
  }) => Effect.Effect<Effect.Effect<void>, UnavailableError>
}

/** Optional host integration for directory lifecycle protection; standalone Core retains its existing behavior. */
export class Service extends Context.Service<Service, Interface>()("@opencode/DirectoryLease") {}
export const layer = Layer.succeed(Service, Service.of({ acquire: () => Effect.succeed(Effect.void) }))
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
