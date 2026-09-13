import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(SessionStatus.node))

it.instance("busy projects reject idle-only resource changes without executing them", () =>
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    yield* status.set(SessionID.make("ses_busy_guard"), { type: "busy" })
    let changed = false
    const result = yield* status
      .whenIdle(
        Effect.sync(() => {
          changed = true
        }),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(changed).toBe(false)
  }),
)

it.instance("task admission waits for an in-progress idle-only resource change", () =>
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const admission = yield* Deferred.make<void>()
    const order: string[] = []
    const change = yield* status
      .whenIdle(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          order.push("changed")
        }),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)
    const task = yield* Effect.gen(function* () {
      yield* Deferred.succeed(admission, undefined)
      yield* status.set(SessionID.make("ses_waiting_guard"), { type: "busy" })
      order.push("busy")
    }).pipe(Effect.forkChild)
    yield* Deferred.await(admission)
    expect((yield* status.list()).size).toBe(0)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(change)
    yield* Fiber.join(task)
    expect(order).toEqual(["changed", "busy"])
    expect((yield* status.list()).size).toBe(1)
  }),
)
