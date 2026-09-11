export * as WorktreeRuntime from "./runtime"

import { DirectoryLease } from "@opencode-ai/core/directory-lease"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionLifecycle } from "@opencode-ai/server/session-lifecycle"
import { CodexHost } from "@opencode-ai/codex/host"
import { ConflictError, ServiceUnavailableError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect, Layer, Option } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { WorktreeLifecycle } from "./lifecycle"

/** Capture the existing host service once; Location Layer.fresh must never create another gate registry. */
export function leases(lifecycle: WorktreeLifecycle.Interface) {
  return Layer.succeed(
    DirectoryLease.Service,
    DirectoryLease.Service.of({
      acquire: Effect.fn("WorktreeRuntime.acquire")(function* (input) {
        const directory = yield* lifecycle
          .leaseDirectory(input.directory)
          .pipe(
            Effect.mapError(
              (error) => new DirectoryLease.UnavailableError({ directory: input.directory, message: error.message }),
            ),
          )
        const lease = { directory, sessionID: input.ownerID }
        yield* lifecycle
          .acquire(lease)
          .pipe(Effect.mapError((error) => new DirectoryLease.UnavailableError({ directory, message: error.message })))
        return yield* Effect.cached(lifecycle.release(lease))
      }),
    }),
  )
}

export const sessionLayer = Layer.effect(
  SessionLifecycle.Service,
  Effect.gen(function* () {
    const lifecycle = yield* WorktreeLifecycle.Service
    const session = yield* Session.Service
    const v2 = yield* SessionV2.Service
    const codex = yield* CodexHost.Service
    const conflict = (error: WorktreeLifecycle.LifecycleFailedError) =>
      new ConflictError({ message: error.message, resource: error.directory })
    const requireSession = (id: SessionID) =>
      session
        .get(id)
        .pipe(Effect.mapError(() => new SessionNotFoundError({ sessionID: id, message: `Session not found: ${id}` })))
    const archived = (id: SessionID, time?: number) =>
      Effect.gen(function* () {
        yield* requireSession(id)
        yield* session.setArchived({ sessionID: id, time }).pipe(Effect.mapError(conflict))
      })
    return SessionLifecycle.Service.of({
      capabilities: {
        archive: true,
        restore: true,
        delete: true,
        managedWorktree: true,
        occupancy: { pty: true, v2: true, externalProcesses: false },
      },
      claim: (info) =>
        lifecycle
          .claim({ directory: info.location.directory, sessionID: info.id })
          .pipe(Effect.asVoid, Effect.mapError(conflict)),
      archive: (id) => archived(id, Date.now()),
      restore: (id) => archived(id),
      remove: (id) =>
        Effect.gen(function* () {
          const current = yield* requireSession(id).pipe(Effect.option)
          if (Option.isNone(current)) {
            const owner = yield* lifecycle.get(id).pipe(Effect.mapError(conflict))
            if (owner?.intent === "delete") {
              yield* lifecycle.finalizeDelete(id).pipe(Effect.mapError(conflict))
              return
            }
            return yield* new SessionNotFoundError({ sessionID: id, message: `Session not found: ${id}` })
          }
          if (current.value.engine === "codex") {
            yield* codex.remove(id).pipe(
              Effect.mapError((error) => {
                if (error.code === "notFound")
                  return new SessionNotFoundError({ sessionID: id, message: error.message })
                if (error.code === "unavailable")
                  return new ServiceUnavailableError({ service: "codex", message: error.message })
                return new ConflictError({ resource: id, message: error.message })
              }),
            )
            return
          }
          const active = yield* v2.active
          const check = Effect.fnUntraced(function* (sessionID: SessionID): Effect.fn.Return<void, ConflictError> {
            if (active.has(sessionID))
              return yield* new ConflictError({
                message: "Session execution is active; stop it before deleting",
                resource: sessionID,
              })
            const children = yield* session.children(sessionID)
            for (const child of children) yield* check(child.id)
          })
          yield* check(id)
          yield* session.remove(id).pipe(
            Effect.catchTag("WorktreeLifecycleFailedError", conflict),
            Effect.catchTag(
              "NotFoundError",
              () => new SessionNotFoundError({ sessionID: id, message: `Session not found: ${id}` }),
            ),
          )
        }),
    })
  }),
)
