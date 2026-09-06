import { DirectoryLease } from "../../directory-lease"
import { Cause, Effect, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionEngineGuard } from "../external/guard"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const leases = yield* DirectoryLease.Service
    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      SessionRunner.RunError | DirectoryLease.UnavailableError
    >({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        yield* SessionEngineGuard.check(session, "drain").pipe(Effect.orDie)
        return yield* Effect.acquireUseRelease(
          leases.acquire({ directory: session.location.directory, ownerID: sessionID }),
          () =>
            SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
              Effect.provide(locations.get(session.location)),
            ),
          (release) => release,
        ).pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: (sessionID) =>
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (session) yield* SessionEngineGuard.check(session, "interrupt").pipe(Effect.orDie)
          yield* coordinator.interrupt(sessionID)
        }),
      resume: (sessionID) =>
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (session) yield* SessionEngineGuard.check(session, "resume").pipe(Effect.orDie)
          yield* coordinator.run(sessionID)
        }),
      wake: (sessionID) =>
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (session) yield* SessionEngineGuard.check(session, "wake").pipe(Effect.orDie)
          yield* coordinator.wake(sessionID)
        }),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, DirectoryLease.node],
})

export * as SessionExecutionLocal from "./local"
