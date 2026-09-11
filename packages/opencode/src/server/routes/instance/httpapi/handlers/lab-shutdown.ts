import { Database } from "@opencode-ai/core/database/database"
import { SessionV2 } from "@opencode-ai/core/session"
import { LabShutdownState } from "@/lab/shutdown-state"
import { WorktreeLifecycle } from "@/worktree/lifecycle"
import { Effect, Exit } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"
import { LabShutdownApi } from "../groups/lab-shutdown"

export const labShutdownHandlers = HttpApiBuilder.group(LabShutdownApi, "lab-shutdown", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const execution = yield* SessionV2.Service
    const lifecycle = yield* WorktreeLifecycle.Service
    return handlers.handle("state", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(LabShutdownState.read({ database, execution, lifecycle }))
        if (Exit.isSuccess(exit)) return { active: exit.value }
        return yield* new ServiceUnavailableError({ message: "Lab shutdown state is unavailable", service: "lab" })
      }),
    )
  }),
)
