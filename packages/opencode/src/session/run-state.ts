import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Context, Effect, Latch, Layer, Scope, Semaphore } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { WorktreeLifecycle } from "@/worktree/lifecycle"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const lifecycle = yield* WorktreeLifecycle.Service
    const { db } = yield* Database.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, { directory: string; runner: Runner.Runner<SessionV1.WithParts> }>()
        const mutation = Semaphore.makeUnsafe(1)
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            const active = [...runners.entries()]
            yield* Effect.forEach(active, (item) => item[1].runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            yield* Effect.forEach(
              active,
              (item) => lifecycle.release({ directory: item[1].directory, sessionID: item[0] }),
              { concurrency: "unbounded", discard: true },
            )
            runners.clear()
          }),
        )
        return { mutation, runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      return yield* data.mutation.withPermits(1)(
        Effect.gen(function* () {
          const existing = data.runners.get(sessionID)
          if (existing) return existing.runner
          const row = yield* db
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* busyError(sessionID)
          const directory = row.directory
          yield* lifecycle.acquire({ directory, sessionID }).pipe(Effect.mapError(() => busyError(sessionID)))
          const next = Runner.make<SessionV1.WithParts>(data.scope, {
            onIdle: data.mutation.withPermits(1)(
              Effect.gen(function* () {
                data.runners.delete(sessionID)
                yield* lifecycle.release({ directory, sessionID })
                yield* status.set(sessionID, { type: "idle" })
              }),
            ),
            onBusy: status.set(sessionID, { type: "busy" }),
            onInterrupt,
          })
          data.runners.set(sessionID, { directory, runner: next })
          return next
        }),
      )
    })

    const cleanupIdle = Effect.fnUntraced(function* (
      sessionID: SessionID,
      current: Runner.Runner<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      yield* data.mutation.withPermits(1)(
        Effect.gen(function* () {
          const entry = data.runners.get(sessionID)
          if (!entry || entry.runner !== current || current.busy) return
          data.runners.delete(sessionID)
          yield* lifecycle.release({ directory: entry.directory, sessionID })
        }),
      )
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.runner.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.runner.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = yield* runner(sessionID, onInterrupt)
          return yield* restore(current.ensureRunning(work)).pipe(Effect.ensuring(cleanupIdle(sessionID, current)))
        }),
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = yield* runner(sessionID, onInterrupt)
          return yield* restore(current.startShell(work, ready)).pipe(
            Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))),
            Effect.ensuring(cleanupIdle(sessionID, current)),
          )
        }),
      )
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, SessionStatus.node, WorktreeLifecycle.node, Database.node],
})

export * as SessionRunState from "./run-state"
