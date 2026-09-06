import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer, Scope } from "effect"
import { InstanceDisposal } from "../../src/project/instance-disposal"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const storeTest = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)
const disposalTest = testEffect(LayerNode.compile(InstanceDisposal.node))

describe("InstanceDisposal", () => {
  storeTest.live("evicts the cached instance before the next load", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const first = yield* store.load({ directory })

      yield* store.disposeDirectory(directory)

      const second = yield* store.load({ directory })
      expect(second).not.toBe(first)
    }),
  )

  disposalTest.live("unregisters a provider with its scope", () =>
    Effect.gen(function* () {
      const disposal = yield* InstanceDisposal.Service
      const scope = yield* Scope.make()
      const calls: string[] = []

      yield* disposal.register((directory) => Effect.sync(() => calls.push(directory))).pipe(
        Effect.provideService(Scope.Scope, scope),
      )
      yield* disposal.disposeDirectory("/tmp/registered")
      expect(calls).toEqual(["/tmp/registered"])

      yield* Scope.close(scope, Exit.void)
      const exit = yield* disposal.disposeDirectory("/tmp/unregistered").pipe(Effect.exit)
      const error = Exit.match(exit, {
        onFailure: (cause) => Cause.squash(cause),
        onSuccess: () => undefined,
      })
      expect(error).toBeInstanceOf(InstanceDisposal.UnavailableError)
    }),
  )

  disposalTest.live("fails explicitly when no provider is registered", () =>
    Effect.gen(function* () {
      const disposal = yield* InstanceDisposal.Service
      const exit = yield* disposal.disposeDirectory("/tmp/unavailable").pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.match(exit, {
        onFailure: (cause) => Cause.squash(cause),
        onSuccess: () => undefined,
      })
      expect(error).toBeInstanceOf(InstanceDisposal.UnavailableError)
    }),
  )
})
