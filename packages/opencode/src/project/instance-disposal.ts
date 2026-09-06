import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { disposeInstance } from "@/effect/instance-registry"

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("InstanceDisposalUnavailableError", {
  directory: Schema.String,
}) {}

export interface Interface {
  readonly register: (provider: (directory: string) => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceDisposal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const providers = new Set<(directory: string) => Effect.Effect<void>>()

    const register = Effect.fnUntraced(function* (provider: (directory: string) => Effect.Effect<void>) {
      providers.add(provider)
      yield* Effect.addFinalizer(() => Effect.sync(() => providers.delete(provider)))
    })

    const disposeDirectory = Effect.fnUntraced(function* (directory: string) {
      if (providers.size === 0) {
        yield* Effect.promise(() => disposeInstance(directory))
        return yield* new UnavailableError({ directory })
      }
      yield* Effect.forEach([...providers], (provider) => provider(directory), { discard: true })
    })

    return Service.of({ register, disposeDirectory })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as InstanceDisposal from "./instance-disposal"
