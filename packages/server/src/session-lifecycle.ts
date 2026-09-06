export * as SessionLifecycle from "./session-lifecycle"

import { Context, Effect, Layer } from "effect"
import { ConflictError, ServiceUnavailableError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { SessionCapabilities } from "@opencode-ai/protocol/groups/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"

export interface Interface {
  readonly capabilities: typeof SessionCapabilities.Type
  readonly claim: (session: typeof SessionSchema.Info.Type) => Effect.Effect<void, ConflictError>
  readonly archive: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, ConflictError | ServiceUnavailableError | SessionNotFoundError>
  readonly restore: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, ConflictError | ServiceUnavailableError | SessionNotFoundError>
  readonly remove: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, ConflictError | ServiceUnavailableError | SessionNotFoundError>
}

/** Host-owned directory lifecycle integration. Standalone servers explicitly advertise unsupported operations. */
export class Service extends Context.Service<Service, Interface>()("@opencode/ServerSessionLifecycle") {}
const unavailable = () =>
  new ServiceUnavailableError({
    message: "This server does not provide session lifecycle management",
    service: "session.lifecycle",
  })
export const layer = Layer.succeed(
  Service,
  Service.of({
    capabilities: {
      archive: false,
      restore: false,
      delete: false,
      managedWorktree: false,
      occupancy: { pty: false, v2: false, externalProcesses: false },
    },
    claim: () => Effect.void,
    archive: unavailable,
    restore: unavailable,
    remove: unavailable,
  }),
)
