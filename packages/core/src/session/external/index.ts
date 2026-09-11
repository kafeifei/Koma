export * as SessionExternal from "."

import { createHash } from "node:crypto"
import path from "node:path"
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../../database/database"
import { makeGlobalNode } from "../../effect/app-node"
import { EventV2 } from "../../event"
import { InstallationVersion } from "../../installation/version"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { Location } from "../../location"
import { ProjectV2 } from "../../project"
import { ProjectTable } from "../../project/sql"
import { Slug } from "../../util/slug"
import { SessionV1 } from "../../v1/session"
import { fromRow } from "../info"
import { SessionProjector } from "../projector"
import { SessionSchema } from "../schema"
import { SessionTable } from "../sql"
import { SessionExternalBindingTable, SessionExternalDeliveryTable } from "./sql"

export type Payload = typeof Schema.Json.Type
export type BindingState = typeof SessionExternalBindingTable.$inferSelect.state
export type DeliveryState = typeof SessionExternalDeliveryTable.$inferSelect.state
export type Binding = ReturnType<typeof bindingInfo>
export type Delivery = ReturnType<typeof deliveryInfo>
export type Descriptor = { session: SessionSchema.Info; binding?: Binding }
export type Record = { session: SessionSchema.Info; binding: Binding }
export type Created = Record & { delivery: Delivery }

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionExternal.NotFound", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionExternal.Conflict", {
  message: Schema.String,
}) {}

export type Error = NotFoundError | ConflictError

export type CreateInput = {
  runtimeScope: string
  requestID: string
  engine: "codex"
  location: Location.Ref
  payload: Payload
  delivery: "steer" | "queue"
  title?: string
  settings?: Payload
}

export type DeliveryInput = {
  sessionID: SessionSchema.ID
  requestID: string
  payload: Payload
  delivery: "steer" | "queue"
}

export type AdoptChildInput = {
  parentID: SessionSchema.ID
  runtimeScope: string
  nativeThreadID: string
  location: Location.Ref
  title?: string
  settings?: Payload
}

export interface Interface {
  readonly getCreation: (runtimeScope: string, requestID: string) => Effect.Effect<Created | undefined, Error>
  readonly create: (input: CreateInput) => Effect.Effect<Created, Error>
  readonly adoptChild: (input: AdoptChildInput) => Effect.Effect<Record, Error>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Record, Error>
  readonly describe: (sessionIDs: ReadonlyArray<SessionSchema.ID>) => Effect.Effect<Descriptor[]>
  readonly admit: (input: DeliveryInput) => Effect.Effect<Delivery, Error>
  readonly getDelivery: (input: {
    sessionID: SessionSchema.ID
    requestID: string
  }) => Effect.Effect<Delivery | undefined>
  readonly pending: (sessionID: SessionSchema.ID) => Effect.Effect<Delivery[], Error>
  readonly deliveries: (sessionID: SessionSchema.ID) => Effect.Effect<Delivery[], Error>
  readonly withdraw: (input: { sessionID: SessionSchema.ID; requestID: string }) => Effect.Effect<Delivery, Error>
  readonly setSettings: (sessionID: SessionSchema.ID, settings: Payload) => Effect.Effect<Binding, Error>
  readonly claimBinding: (input: {
    sessionID: SessionSchema.ID
    generation: string
  }) => Effect.Effect<Binding | undefined, Error>
  readonly bind: (input: {
    sessionID: SessionSchema.ID
    nativeThreadID: string
    generation: string
  }) => Effect.Effect<Binding, Error>
  /** Only a trusted native creation response may resolve an uncertain binding. */
  readonly reconcileBinding: (input: {
    sessionID: SessionSchema.ID
    runtimeScope: string
    nativeThreadID: string
    generation: string
  }) => Effect.Effect<Binding, Error>
  readonly markBindingUnknown: (input: {
    sessionID: SessionSchema.ID
    generation: string
    error?: string
  }) => Effect.Effect<Binding, Error>
  readonly claim: (input: {
    sessionID: SessionSchema.ID
    requestID: string
    generation: string
  }) => Effect.Effect<Delivery | undefined, Error>
  readonly settle: (input: {
    sessionID: SessionSchema.ID
    requestID: string
    generation: string
    state: "accepted" | "unknown" | "rejected"
    nativeTurnID?: string
    nativeItemID?: string
    error?: string
  }) => Effect.Effect<Delivery, Error>
  readonly setExecutionPending: (sessionID: SessionSchema.ID, pending: boolean) => Effect.Effect<Binding, Error>
  readonly setQueuePaused: (sessionID: SessionSchema.ID, paused: boolean) => Effect.Effect<void, Error>
  readonly recover: (runtimeScope: string) => Effect.Effect<void>
  readonly syncTitle: (input: {
    sessionID: SessionSchema.ID
    runtimeScope: string
    nativeThreadID: string
    title?: string
    previousTitle?: string
  }) => Effect.Effect<string | undefined, Error>
  readonly touch: (sessionID: SessionSchema.ID, time: number) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExternal") {}

class CreationRace extends Error {}
class BindingRace extends Error {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service

    const readBinding = (sessionID: SessionSchema.ID) =>
      db
        .select()
        .from(SessionExternalBindingTable)
        .where(eq(SessionExternalBindingTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)

    const readDelivery = (input: { sessionID: SessionSchema.ID; requestID: string }) =>
      db
        .select()
        .from(SessionExternalDeliveryTable)
        .where(
          and(
            eq(SessionExternalDeliveryTable.session_id, input.sessionID),
            eq(SessionExternalDeliveryTable.request_id, input.requestID),
          ),
        )
        .get()
        .pipe(Effect.orDie)

    const get = Effect.fn("SessionExternal.get")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ sessionID, message: `Session not found: ${sessionID}` })
      if (row.engine !== "codex")
        return yield* new ConflictError({ message: `Session ${sessionID} is owned by ${row.engine}` })
      const binding = yield* readBinding(sessionID)
      if (!binding)
        return yield* new ConflictError({ message: `External Session ${sessionID} has no native binding record` })
      return { session: fromRow(row), binding: bindingInfo(binding) }
    })

    const readCreation = (runtimeScope: string, requestID: string) =>
      db
        .select()
        .from(SessionExternalDeliveryTable)
        .where(
          and(
            eq(SessionExternalDeliveryTable.create_scope, runtimeScope),
            eq(SessionExternalDeliveryTable.request_id, requestID),
          ),
        )
        .get()
        .pipe(Effect.orDie)

    const creationResult = Effect.fnUntraced(function* (
      row: typeof SessionExternalDeliveryTable.$inferSelect,
      fingerprint: string,
    ) {
      if (row.create_fingerprint !== fingerprint)
        return yield* new ConflictError({
          message: `Creation request ${row.request_id} was reused with different input`,
        })
      return { ...(yield* get(row.session_id)), delivery: deliveryInfo(row) }
    })

    const create = Effect.fn("SessionExternal.create")(function* (input: CreateInput) {
      if (input.engine !== "codex" || !input.runtimeScope || !input.requestID)
        return yield* new ConflictError({
          message: "External creation requires an engine, runtime scope and request ID",
        })
      const payload = yield* decodePayload(input.payload)
      const settings = yield* decodePayload(input.settings ?? {})
      const fingerprint = digest({
        runtimeScope: input.runtimeScope,
        location: { directory: input.location.directory, workspaceID: input.location.workspaceID ?? null },
        engine: input.engine,
        payload,
        delivery: input.delivery,
        title: input.title ?? null,
        settings,
      })
      const existing = yield* readCreation(input.runtimeScope, input.requestID)
      if (existing) return yield* creationResult(existing, fingerprint)
      const project = yield* projects.resolve(input.location.directory)
      yield* db
        .insert(ProjectTable)
        .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const sessionID = SessionSchema.ID.create()
      const time = Date.now()
      const info = SessionV1.SessionInfo.make({
        id: sessionID,
        engine: input.engine,
        projectID: project.id,
        workspaceID: input.location.workspaceID,
        directory: input.location.directory,
        path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
        slug: Slug.create(),
        title: input.title ?? promptTitle(payload) ?? `New session - ${new Date(time).toISOString()}`,
        version: InstallationVersion,
        time: { created: time, updated: time },
      })
      // The existing projector and this operational commit share one immediate transaction.
      // Losing the scope/request-ID race rolls back the new Session and its Created event.
      yield* events
        .publish(
          SessionV1.Event.Created,
          { sessionID, info },
          {
            location: input.location,
            commit: () =>
              Effect.gen(function* () {
                const claimed = yield* db
                  .insert(SessionExternalDeliveryTable)
                  .values({
                    session_id: sessionID,
                    request_id: input.requestID,
                    sequence: 1,
                    create_scope: input.runtimeScope,
                    create_fingerprint: fingerprint,
                    fingerprint: digest({ payload, delivery: input.delivery }),
                    payload,
                    delivery: input.delivery,
                    state: "pending",
                    time_created: time,
                    time_updated: time,
                  })
                  .onConflictDoNothing()
                  .returning({ sessionID: SessionExternalDeliveryTable.session_id })
                  .get()
                  .pipe(Effect.orDie)
                if (!claimed) return yield* Effect.die(new CreationRace())
                yield* db
                  .insert(SessionExternalBindingTable)
                  .values({
                    session_id: sessionID,
                    runtime_scope: input.runtimeScope,
                    state: "pending",
                    settings,
                    time_updated: time,
                  })
                  .run()
                  .pipe(Effect.orDie)
              }),
          },
        )
        .pipe(Effect.catchDefect((error) => (error instanceof CreationRace ? Effect.void : Effect.die(error))))
      const recorded = yield* readCreation(input.runtimeScope, input.requestID)
      if (!recorded) return yield* new ConflictError({ message: "External creation did not persist its receipt" })
      return yield* creationResult(recorded, fingerprint)
    })

    const admit = Effect.fn("SessionExternal.admit")(function* (input: DeliveryInput) {
      const record = yield* get(input.sessionID)
      if (record.session.time.archived !== undefined)
        return yield* new ConflictError({
          message: `Session ${input.sessionID} is archived; restore it before sending input`,
        })
      if (!input.requestID) return yield* new ConflictError({ message: "Input requires a request ID" })
      const payload = yield* decodePayload(input.payload)
      const fingerprint = digest({ payload, delivery: input.delivery })
      const time = Date.now()
      yield* db
        .insert(SessionExternalDeliveryTable)
        .values({
          session_id: input.sessionID,
          request_id: input.requestID,
          sequence: sql`(SELECT coalesce(max(sequence), 0) + 1 FROM session_external_delivery WHERE session_id = ${input.sessionID})`,
          fingerprint,
          payload,
          delivery: input.delivery,
          state: "pending",
          time_created: time,
          time_updated: time,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const recorded = yield* readDelivery(input)
      if (!recorded || recorded.fingerprint !== fingerprint)
        return yield* new ConflictError({ message: `Input request ${input.requestID} was reused with different input` })
      return deliveryInfo(recorded)
    })

    const syncTitle = Effect.fn("SessionExternal.syncTitle")(function* (input: Parameters<Interface["syncTitle"]>[0]) {
      // Read and publish inside one transaction so a concurrent manual rename or
      // usage update cannot be replaced by the full legacy Session projection.
      return yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              const current = yield* get(input.sessionID)
              if (
                current.binding.runtimeScope !== input.runtimeScope ||
                current.binding.nativeThreadID !== input.nativeThreadID
              )
                return yield* new ConflictError({ message: "Native title must belong to its bound Session" })
              const row = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, input.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* new NotFoundError({ sessionID: input.sessionID, message: "Session disappeared" })
              const first = yield* db
                .select()
                .from(SessionExternalDeliveryTable)
                .where(
                  and(
                    eq(SessionExternalDeliveryTable.session_id, input.sessionID),
                    eq(SessionExternalDeliveryTable.sequence, 1),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              const initial = first?.create_scope ? promptTitle(first.payload) : undefined
              if (
                !/^New session - \d{4}-\d{2}-\d{2}T/.test(row.title) &&
                row.title !== initial &&
                row.title !== input.previousTitle
              )
                return
              const title = input.title?.trim() || initial
              if (!title || title === row.title) return
              yield* events.publish(
                SessionV1.Event.Updated,
                {
                  sessionID: input.sessionID,
                  info: SessionV1.SessionInfo.make({
                    id: row.id,
                    engine: row.engine,
                    projectID: row.project_id,
                    workspaceID: row.workspace_id ?? undefined,
                    parentID: row.parent_id ?? undefined,
                    slug: row.slug,
                    directory: row.directory,
                    path: row.path ?? undefined,
                    title,
                    agent: row.agent ?? undefined,
                    model: row.model
                      ? {
                          ...row.model,
                          id: ModelV2.ID.make(row.model.id),
                          providerID: ProviderV2.ID.make(row.model.providerID),
                        }
                      : undefined,
                    version: row.version,
                    share: row.share_url ? { url: row.share_url } : undefined,
                    summary:
                      row.summary_files === null
                        ? undefined
                        : {
                            additions: row.summary_additions ?? 0,
                            deletions: row.summary_deletions ?? 0,
                            files: row.summary_files,
                            diffs: row.summary_diffs ?? undefined,
                          },
                    metadata: row.metadata ?? undefined,
                    cost: row.cost,
                    tokens: {
                      input: row.tokens_input,
                      output: row.tokens_output,
                      reasoning: row.tokens_reasoning,
                      cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
                    },
                    revert: row.revert
                      ? {
                          ...row.revert,
                          messageID: SessionV1.MessageID.make(row.revert.messageID),
                          partID: row.revert.partID ? SessionV1.PartID.make(row.revert.partID) : undefined,
                        }
                      : undefined,
                    permission: row.permission ?? undefined,
                    permissionMode: row.permission_mode ?? undefined,
                    time: {
                      created: row.time_created,
                      updated: row.time_updated,
                      compacting: row.time_compacting ?? undefined,
                      archived: row.time_archived ?? undefined,
                    },
                  }),
                },
                {
                  location: current.session.location,
                  // The legacy event cannot represent newer row fields such as
                  // revert.files. Keep the persisted row exact in this transaction.
                  commit: () =>
                    db
                      .update(SessionTable)
                      .set({ ...row, title })
                      .where(eq(SessionTable.id, row.id))
                      .run()
                      .pipe(Effect.orDie),
                },
              )
              return title
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({
      create,
      syncTitle,
      getCreation: Effect.fn("SessionExternal.getCreation")(function* (runtimeScope, requestID) {
        const row = yield* readCreation(runtimeScope, requestID)
        if (!row) return
        return { ...(yield* get(row.session_id)), delivery: deliveryInfo(row) }
      }),
      adoptChild: Effect.fn("SessionExternal.adoptChild")(function* (input) {
        const parent = yield* get(input.parentID)
        if (!input.nativeThreadID || parent.binding.runtimeScope !== input.runtimeScope)
          return yield* new ConflictError({ message: "Native child must belong to its parent's runtime scope" })
        const project = yield* projects.resolve(input.location.directory)
        if (
          project.id !== parent.session.projectID ||
          (project.id === ProjectV2.ID.global &&
            input.location.directory !== parent.session.location.directory &&
            !input.location.directory.startsWith(`${parent.session.location.directory}${path.sep}`))
        )
          return yield* new ConflictError({ message: "Native child location must belong to its parent's project" })
        const settings = yield* decodePayload(input.settings ?? {})
        const find = () =>
          db
            .select()
            .from(SessionExternalBindingTable)
            .where(
              and(
                eq(SessionExternalBindingTable.runtime_scope, input.runtimeScope),
                eq(SessionExternalBindingTable.native_thread_id, input.nativeThreadID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
        const existing = yield* find()
        if (!existing) {
          const sessionID = SessionSchema.ID.create()
          const time = Date.now()
          yield* events
            .publish(
              SessionV1.Event.Created,
              {
                sessionID,
                info: SessionV1.SessionInfo.make({
                  id: sessionID,
                  engine: "codex",
                  parentID: input.parentID,
                  projectID: project.id,
                  workspaceID: input.location.workspaceID,
                  directory: input.location.directory,
                  path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
                  slug: Slug.create(),
                  title: input.title ?? `Native child - ${new Date(time).toISOString()}`,
                  version: InstallationVersion,
                  time: { created: time, updated: time },
                }),
              },
              {
                location: input.location,
                commit: () =>
                  Effect.gen(function* () {
                    const inserted = yield* db
                      .insert(SessionExternalBindingTable)
                      .values({
                        session_id: sessionID,
                        runtime_scope: input.runtimeScope,
                        native_thread_id: input.nativeThreadID,
                        state: "bound",
                        execution_pending: true,
                        settings,
                        time_updated: time,
                      })
                      .onConflictDoNothing()
                      .returning({ sessionID: SessionExternalBindingTable.session_id })
                      .get()
                      .pipe(Effect.orDie)
                    if (!inserted) return yield* Effect.die(new BindingRace())
                  }),
              },
            )
            .pipe(Effect.catchDefect((error) => (error instanceof BindingRace ? Effect.void : Effect.die(error))))
        }
        const binding = existing ?? (yield* find())
        if (!binding) return yield* new ConflictError({ message: "Native child binding was not persisted" })
        const record = yield* get(binding.session_id)
        if (
          record.session.parentID !== input.parentID ||
          record.session.projectID !== project.id ||
          record.session.location.directory !== input.location.directory ||
          record.session.location.workspaceID !== input.location.workspaceID
        )
          return yield* new ConflictError({
            message: "Native thread already belongs to a different Session relationship or location",
          })
        return record
      }),
      get,
      admit,
      describe: Effect.fn("SessionExternal.describe")(function* (sessionIDs) {
        if (!sessionIDs.length) return []
        const rows = yield* db
          .select()
          .from(SessionTable)
          .where(inArray(SessionTable.id, sessionIDs))
          .all()
          .pipe(Effect.orDie)
        const bindings = new Map(
          (yield* db
            .select()
            .from(SessionExternalBindingTable)
            .where(inArray(SessionExternalBindingTable.session_id, sessionIDs))
            .all()
            .pipe(Effect.orDie)).map((row) => [row.session_id, bindingInfo(row)]),
        )
        return rows.map((row) => ({ session: fromRow(row), binding: bindings.get(row.id) }))
      }),
      getDelivery: Effect.fn("SessionExternal.getDelivery")(function* (input) {
        const row = yield* readDelivery(input)
        return row ? deliveryInfo(row) : undefined
      }),
      pending: Effect.fn("SessionExternal.pending")(function* (sessionID) {
        const record = yield* get(sessionID)
        const rows = yield* db
          .select()
          .from(SessionExternalDeliveryTable)
          .where(
            and(
              eq(SessionExternalDeliveryTable.session_id, sessionID),
              eq(SessionExternalDeliveryTable.state, "pending"),
            ),
          )
          .orderBy(asc(SessionExternalDeliveryTable.sequence))
          .all()
          .pipe(Effect.orDie)
        return rows.filter((row) => row.delivery !== "queue" || !record.binding.queuePaused).map(deliveryInfo)
      }),
      deliveries: Effect.fn("SessionExternal.deliveries")(function* (sessionID) {
        yield* get(sessionID)
        return (yield* db
          .select()
          .from(SessionExternalDeliveryTable)
          .where(eq(SessionExternalDeliveryTable.session_id, sessionID))
          .orderBy(asc(SessionExternalDeliveryTable.sequence))
          .all()
          .pipe(Effect.orDie)).map(deliveryInfo)
      }),
      withdraw: Effect.fn("SessionExternal.withdraw")(function* (input) {
        yield* get(input.sessionID)
        const row = yield* db
          .update(SessionExternalDeliveryTable)
          .set({ state: "withdrawn", time_updated: Date.now() })
          .where(
            and(
              eq(SessionExternalDeliveryTable.session_id, input.sessionID),
              eq(SessionExternalDeliveryTable.request_id, input.requestID),
              eq(SessionExternalDeliveryTable.state, "pending"),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (row) return deliveryInfo(row)
        const recorded = yield* readDelivery(input)
        if (recorded?.state === "withdrawn") return deliveryInfo(recorded)
        return yield* new ConflictError({ message: "Only a pending input may be withdrawn" })
      }),
      setSettings: Effect.fn("SessionExternal.setSettings")(function* (sessionID, value) {
        yield* get(sessionID)
        const settings = yield* decodePayload(value)
        const row = yield* db
          .update(SessionExternalBindingTable)
          .set({ settings, time_updated: Date.now() })
          .where(eq(SessionExternalBindingTable.session_id, sessionID))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new ConflictError({ message: "External binding no longer exists" })
        return bindingInfo(row)
      }),
      claimBinding: Effect.fn("SessionExternal.claimBinding")(function* (input) {
        yield* get(input.sessionID)
        const row = yield* db
          .update(SessionExternalBindingTable)
          .set({ state: "creating", generation: input.generation, time_updated: Date.now() })
          .where(
            and(
              eq(SessionExternalBindingTable.session_id, input.sessionID),
              eq(SessionExternalBindingTable.state, "pending"),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        return row ? bindingInfo(row) : undefined
      }),
      bind: Effect.fn("SessionExternal.bind")(function* (input) {
        const record = yield* get(input.sessionID)
        if (record.binding.state === "bound" && record.binding.nativeThreadID === input.nativeThreadID)
          return record.binding
        if (!input.nativeThreadID) return yield* new ConflictError({ message: "Native thread ID is required" })
        const row = yield* db
          .update(SessionExternalBindingTable)
          .set({ native_thread_id: input.nativeThreadID, state: "bound", error: null, time_updated: Date.now() })
          .where(
            and(
              eq(SessionExternalBindingTable.session_id, input.sessionID),
              eq(SessionExternalBindingTable.state, "creating"),
              eq(SessionExternalBindingTable.generation, input.generation),
              isNull(SessionExternalBindingTable.native_thread_id),
            ),
          )
          .returning()
          .get()
          .pipe(
            Effect.mapError(
              () => new ConflictError({ message: "Native thread is already bound in this runtime scope" }),
            ),
          )
        if (!row) return yield* new ConflictError({ message: "Binding is no longer owned by this creation attempt" })
        return bindingInfo(row)
      }),
      reconcileBinding: Effect.fn("SessionExternal.reconcileBinding")(function* (input) {
        const record = yield* get(input.sessionID)
        if (record.binding.runtimeScope !== input.runtimeScope || !input.nativeThreadID)
          return yield* new ConflictError({ message: "Native binding evidence belongs to another runtime scope" })
        if (record.binding.state === "bound" && record.binding.nativeThreadID === input.nativeThreadID)
          return record.binding
        const row = yield* db
          .update(SessionExternalBindingTable)
          .set({ native_thread_id: input.nativeThreadID, state: "bound", error: null, time_updated: Date.now() })
          .where(
            and(
              eq(SessionExternalBindingTable.session_id, input.sessionID),
              eq(SessionExternalBindingTable.runtime_scope, input.runtimeScope),
              eq(SessionExternalBindingTable.generation, input.generation),
              inArray(SessionExternalBindingTable.state, ["creating", "unknown"]),
              isNull(SessionExternalBindingTable.native_thread_id),
            ),
          )
          .returning()
          .get()
          .pipe(
            Effect.mapError(() => new ConflictError({ message: "Native thread already belongs to another Session" })),
          )
        if (!row)
          return yield* new ConflictError({ message: "Native binding evidence does not match its creation attempt" })
        return bindingInfo(row)
      }),
      markBindingUnknown: Effect.fn("SessionExternal.markBindingUnknown")(function* (input) {
        yield* get(input.sessionID)
        const row = yield* db
          .update(SessionExternalBindingTable)
          .set({ state: "unknown", error: input.error, time_updated: Date.now() })
          .where(
            and(
              eq(SessionExternalBindingTable.session_id, input.sessionID),
              inArray(SessionExternalBindingTable.state, ["creating", "unknown"]),
              eq(SessionExternalBindingTable.generation, input.generation),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new ConflictError({ message: "Binding creation attempt is no longer current" })
        return bindingInfo(row)
      }),
      claim: Effect.fn("SessionExternal.claim")(function* (input) {
        yield* get(input.sessionID)
        return yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                const binding = yield* readBinding(input.sessionID)
                if (binding?.state !== "bound") return undefined
                const uncertain = yield* db
                  .select({ requestID: SessionExternalDeliveryTable.request_id })
                  .from(SessionExternalDeliveryTable)
                  .where(
                    and(
                      eq(SessionExternalDeliveryTable.session_id, input.sessionID),
                      inArray(SessionExternalDeliveryTable.state, ["sending", "unknown"]),
                    ),
                  )
                  .get()
                if (uncertain) return undefined
                const row = yield* db
                  .update(SessionExternalDeliveryTable)
                  .set({ state: "sending", generation: input.generation, time_updated: Date.now() })
                  .where(
                    and(
                      eq(SessionExternalDeliveryTable.session_id, input.sessionID),
                      eq(SessionExternalDeliveryTable.request_id, input.requestID),
                      eq(SessionExternalDeliveryTable.state, "pending"),
                      binding.queue_paused ? eq(SessionExternalDeliveryTable.delivery, "steer") : undefined,
                    ),
                  )
                  .returning()
                  .get()
                if (!row) return undefined
                yield* db
                  .update(SessionExternalBindingTable)
                  .set({ execution_pending: true, time_updated: Date.now() })
                  .where(eq(SessionExternalBindingTable.session_id, input.sessionID))
                  .run()
                return deliveryInfo(row)
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      settle: Effect.fn("SessionExternal.settle")(function* (input) {
        yield* get(input.sessionID)
        const row = yield* db
          .update(SessionExternalDeliveryTable)
          .set({
            state: input.state,
            native_turn_id: input.nativeTurnID,
            native_item_id: input.nativeItemID,
            error: input.error,
            time_updated: Date.now(),
          })
          .where(
            and(
              eq(SessionExternalDeliveryTable.session_id, input.sessionID),
              eq(SessionExternalDeliveryTable.request_id, input.requestID),
              eq(SessionExternalDeliveryTable.generation, input.generation),
              or(
                inArray(SessionExternalDeliveryTable.state, ["sending", "unknown"]),
                // A transport acknowledgement is not proof that the input entered
                // native history. Exact client ID evidence may enrich it later.
                input.state === "accepted" && input.nativeTurnID && input.nativeItemID
                  ? and(
                      eq(SessionExternalDeliveryTable.state, "accepted"),
                      isNull(SessionExternalDeliveryTable.native_item_id),
                      or(
                        isNull(SessionExternalDeliveryTable.native_turn_id),
                        eq(SessionExternalDeliveryTable.native_turn_id, input.nativeTurnID),
                      ),
                    )
                  : undefined,
              ),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (row) return deliveryInfo(row)
        const recorded = yield* readDelivery(input)
        if (
          recorded?.generation === input.generation &&
          recorded.state === input.state &&
          (input.nativeTurnID === undefined || recorded.native_turn_id === input.nativeTurnID) &&
          (input.nativeItemID === undefined || recorded.native_item_id === input.nativeItemID)
        )
          return deliveryInfo(recorded)
        return yield* new ConflictError({
          message: "Delivery is not owned by this attempt or already has a different outcome",
        })
      }),
      setExecutionPending: Effect.fn("SessionExternal.setExecutionPending")(function* (sessionID, pending) {
        yield* get(sessionID)
        const row = yield* db
          .update(SessionExternalBindingTable)
          .set({ execution_pending: pending, time_updated: Date.now() })
          .where(eq(SessionExternalBindingTable.session_id, sessionID))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ sessionID, message: "External Session binding disappeared" })
        return bindingInfo(row)
      }),
      setQueuePaused: Effect.fn("SessionExternal.setQueuePaused")(function* (sessionID, paused) {
        yield* get(sessionID)
        yield* db
          .update(SessionExternalBindingTable)
          .set({ queue_paused: paused })
          .where(eq(SessionExternalBindingTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
      recover: Effect.fn("SessionExternal.recover")(function* (runtimeScope) {
        yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                const sessions = db
                  .select({ sessionID: SessionExternalBindingTable.session_id })
                  .from(SessionExternalBindingTable)
                  .where(eq(SessionExternalBindingTable.runtime_scope, runtimeScope))
                yield* db
                  .update(SessionExternalDeliveryTable)
                  .set({ state: "unknown", time_updated: Date.now() })
                  .where(
                    and(
                      inArray(SessionExternalDeliveryTable.session_id, sessions),
                      eq(SessionExternalDeliveryTable.state, "sending"),
                    ),
                  )
                  .run()
                yield* db
                  .update(SessionExternalBindingTable)
                  .set({ state: "unknown", time_updated: Date.now() })
                  .where(
                    and(
                      eq(SessionExternalBindingTable.runtime_scope, runtimeScope),
                      eq(SessionExternalBindingTable.state, "creating"),
                    ),
                  )
                  .run()
                yield* db
                  .update(SessionExternalBindingTable)
                  .set({ queue_paused: true })
                  .where(eq(SessionExternalBindingTable.runtime_scope, runtimeScope))
                  .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      touch: Effect.fn("SessionExternal.touch")(function* (sessionID, time) {
        yield* get(sessionID)
        if (!Number.isFinite(time) || time < 0)
          return yield* new ConflictError({ message: "Activity time must be non-negative and finite" })
        yield* db
          .update(SessionTable)
          .set({ time_updated: sql`max(${SessionTable.time_updated}, ${time})` })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionProjector.node, ProjectV2.node],
})

function bindingInfo(row: typeof SessionExternalBindingTable.$inferSelect) {
  return {
    sessionID: row.session_id,
    runtimeScope: row.runtime_scope,
    nativeThreadID: row.native_thread_id ?? undefined,
    state: row.state,
    generation: row.generation ?? undefined,
    queuePaused: row.queue_paused,
    executionPending: row.execution_pending,
    settings: row.settings,
    projectionVersion: row.projection_version,
    updated: row.time_updated,
    error: row.error ?? undefined,
  }
}

function deliveryInfo(row: typeof SessionExternalDeliveryTable.$inferSelect) {
  return {
    sessionID: row.session_id,
    requestID: row.request_id,
    sequence: row.sequence,
    payload: row.payload,
    delivery: row.delivery,
    state: row.state,
    generation: row.generation ?? undefined,
    nativeTurnID: row.native_turn_id ?? undefined,
    nativeItemID: row.native_item_id ?? undefined,
    created: row.time_created,
    updated: row.time_updated,
    error: row.error ?? undefined,
  }
}

function decodePayload(value: Payload) {
  return Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError(
      () => new ConflictError({ message: "Delivery payload must contain recoverable JSON input and settings" }),
    ),
  )
}

function digest(value: Payload): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function canonical(value: Payload): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const object = value as { readonly [key: string]: Payload }
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key]!)}`)
    .join(",")}}`
}

/** A deterministic first-line title does not start a second model execution. */
function promptTitle(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("prompt" in payload)) return
  const prompt = payload.prompt
  if (!prompt || typeof prompt !== "object" || !("text" in prompt) || typeof prompt.text !== "string") return
  const line = prompt.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\s+/g, " ")
  if (!line) return
  return Array.from(line).slice(0, 120).join("")
}
