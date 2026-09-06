export * as SessionExternalOwnership from "./ownership"

import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../../database/database"
import { SessionExternalBindingTable } from "./sql"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionSchema } from "../schema"

export interface Interface {
  readonly beginGeneration: (runtimeScope: string, generation: string) => Effect.Effect<void>
  readonly confirmIdle: (input: {
    runtimeScope: string
    generation: string
    sessionID: SessionSchema.ID
  }) => Effect.Effect<boolean>
  readonly invalidate: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly invalidateScope: (runtimeScope: string) => Effect.Effect<void>
  readonly isIdle: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

/** Native owners report observed idle; absence, disconnect and process restart are unknown. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExternalOwnership") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const generations = new Map<string, string>()
    const idle = new Map<SessionSchema.ID, { runtimeScope: string; generation: string }>()
    const clear = (runtimeScope: string) => {
      for (const [sessionID, state] of idle) if (state.runtimeScope === runtimeScope) idle.delete(sessionID)
    }
    return Service.of({
      beginGeneration: (runtimeScope, generation) =>
        Effect.sync(() => {
          if (generations.get(runtimeScope) === generation) return
          clear(runtimeScope)
          generations.set(runtimeScope, generation)
        }),
      confirmIdle: (input) =>
        Effect.sync(() => {
          if (generations.get(input.runtimeScope) !== input.generation) return false
          idle.set(input.sessionID, { runtimeScope: input.runtimeScope, generation: input.generation })
          return true
        }),
      invalidate: (sessionID) =>
        Effect.sync(() => {
          idle.delete(sessionID)
        }),
      invalidateScope: (runtimeScope) =>
        Effect.sync(() => {
          clear(runtimeScope)
          generations.delete(runtimeScope)
        }),
      isIdle: (sessionID) =>
        Effect.gen(function* () {
          const state = idle.get(sessionID)
          if (state === undefined || generations.get(state.runtimeScope) !== state.generation) return false
          const binding = yield* database.db
            .select({ pending: SessionExternalBindingTable.execution_pending })
            .from(SessionExternalBindingTable)
            .where(eq(SessionExternalBindingTable.session_id, sessionID))
            .get()
            .pipe(Effect.orDie)
          return binding?.pending !== true
        }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
