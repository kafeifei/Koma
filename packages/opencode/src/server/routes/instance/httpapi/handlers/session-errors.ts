import { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"
import { LifecycleFailedError } from "@/worktree/lifecycle"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, E, R>(self: Effect.Effect<A, E | StorageNotFoundError, R>) {
  return self.pipe(
    Effect.catchIf(StorageNotFoundError.isInstance, (error) => Effect.fail(ApiError.notFound(error.message))),
  )
}

export function mapBusy<A, E, R>(self: Effect.Effect<A, E | Session.BusyError, R>) {
  return self.pipe(
    Effect.catchIf(
      (error): error is Session.BusyError => error instanceof Session.BusyError,
      (error) =>
        Effect.fail(
          new ApiError.SessionBusyError({
            sessionID: error.sessionID,
            message: `Session is busy: ${error.sessionID}`,
          }),
        ),
    ),
  )
}

export function mapArchived<A, E, R>(self: Effect.Effect<A, E | Session.ArchivedError, R>) {
  return self.pipe(
    Effect.catchIf(
      (error): error is Session.ArchivedError => error instanceof Session.ArchivedError,
      (error) =>
        Effect.fail(
          new ApiError.ConflictError({
            resource: error.sessionID,
            message: `Session is archived: ${error.sessionID}`,
          }),
        ),
    ),
  )
}

export function mapLifecycle<A, E, R>(self: Effect.Effect<A, E | LifecycleFailedError, R>, sessionID: string) {
  return self.pipe(
    Effect.catchIf(
      (error): error is LifecycleFailedError => error instanceof LifecycleFailedError,
      (error) =>
        Effect.fail(
          new ApiError.SessionBusyError({
            sessionID,
            message: error.message,
          }),
        ),
    ),
  )
}
