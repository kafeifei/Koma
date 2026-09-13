import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema, Semaphore } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionStatus.BusyError", {}) {}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  readonly whenIdle: <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.Effect<A, E | BusyError, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(function* () {
        return { data: new Map<SessionID, Info>(), gate: yield* Semaphore.make(1) }
      }),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const { data } = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map((yield* InstanceState.get(state)).data)
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const { data, gate } = yield* InstanceState.get(state)
      // Task admission and idle-only resource changes share this gate. A task
      // cannot become busy between the idle check and the resource mutation.
      yield* gate.withPermits(1)(
        Effect.gen(function* () {
          yield* events.publish(Event.Status, { sessionID, status })
          if (status.type === "idle") {
            yield* events.publish(Event.Idle, { sessionID })
            data.delete(sessionID)
            return
          }
          data.set(sessionID, status)
        }),
      )
    })

    const whenIdle: Interface["whenIdle"] = (operation) =>
      Effect.gen(function* () {
        const { data, gate } = yield* InstanceState.get(state)
        return yield* gate.withPermits(1)(
          Effect.gen(function* () {
            if (data.size) return yield* new BusyError({})
            return yield* operation
          }),
        )
      })

    return Service.of({ get, list, set, whenIdle })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"
