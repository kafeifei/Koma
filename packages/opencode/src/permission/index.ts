import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context, Semaphore } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { SessionPermissionMode } from "@opencode-ai/core/session/permission-mode"
import { SessionEvent } from "@opencode-ai/core/session/event"
import type { PermissionMode } from "@opencode-ai/schema/session-permission-mode"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceRef } from "@/effect/instance-ref"
import { SessionV2 } from "@opencode-ai/core/session"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  ruleset: PermissionV1.Ruleset
  deferred: Deferred.Deferred<void, PermissionV1.DeniedError | PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  location: Location.Ref
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const coreEvents = yield* EventV2.Service
    const db = (yield* Database.Service).db
    const gate = Semaphore.makeUnsafe(1)
    const states = new Set<State>()
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const workspaceID = yield* WorkspaceRef
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
          location: Location.Ref.make({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
          }),
        }
        states.add(state)

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
            states.delete(state)
          }),
        )

        return state
      }),
    )

    const evaluateInput = Effect.fnUntraced(function* (
      input: Pick<PermissionV1.AskInput, "sessionID" | "permission" | "patterns" | "ruleset">,
      approved: PermissionV1.Rule[],
    ) {
      const mode = yield* SessionPermissionMode.resolve(db, input.sessionID)
      if (mode === "full") return { effect: "allow" as const, ruleset: input.ruleset }
      let needsAsk = false
      for (const pattern of input.patterns) {
        const rule = evaluate(input.permission, pattern, input.ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: input.permission, pattern, action: rule })
        if (rule.action === "deny") return { effect: "deny" as const, ruleset: input.ruleset }
        if (rule.action === "ask") needsAsk = true
      }
      if (!needsAsk || mode === "auto") return { effect: "allow" as const, ruleset: input.ruleset }
      return { effect: "ask" as const, ruleset: input.ruleset }
    })

    const settleMode = Effect.fnUntraced(function* (
      current: State,
      item: PendingEntry,
      publish: EventV2.Interface["publish"] = events.publish,
    ) {
      const result = yield* evaluateInput({ ...item.info, ruleset: item.ruleset }, current.approved)
      if (result.effect === "ask") return
      current.pending.delete(item.info.id)
      yield* publish(Event.Replied, {
        sessionID: item.info.sessionID,
        requestID: item.info.id,
        reply: result.effect === "deny" ? "reject" : "once",
      })
      if (result.effect === "deny") {
        return yield* Deferred.fail(
          item.deferred,
          new PermissionV1.DeniedError({
            ruleset: result.ruleset.filter((rule) => Wildcard.match(item.info.permission, rule.permission)),
          }),
        )
      }
      yield* Deferred.succeed(item.deferred, undefined)
    })

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const item = yield* gate.withPermit(
        Effect.gen(function* () {
          const current = yield* InstanceState.get(state)
          const { approved, pending } = current
          const { ruleset, ...request } = input
          const result = yield* evaluateInput(input, approved)
          if (result.effect === "deny") {
            return yield* new PermissionV1.DeniedError({
              ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
            })
          }
          if (result.effect === "allow") return

          const id = request.id ?? PermissionV1.ID.ascending()
          const info: PermissionV1.Request = {
            id,
            sessionID: request.sessionID,
            permission: request.permission,
            patterns: request.patterns,
            metadata: request.metadata,
            always: request.always,
            tool: request.tool,
          }
          yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

          const deferred = yield* Deferred.make<
            void,
            PermissionV1.DeniedError | PermissionV1.RejectedError | PermissionV1.CorrectedError
          >()
          const item = { info, ruleset, deferred }
          pending.set(id, item)
          yield* events.publish(Event.Asked, info)
          yield* settleMode(current, item)
          return item
        }),
      )
      if (!item) return
      return yield* Effect.ensuring(
        Deferred.await(item.deferred),
        InstanceState.get(state).pipe(
          Effect.tap((current) => Effect.sync(() => current.pending.delete(item.info.id))),
          Effect.asVoid,
        ),
      )
    })

    const reply = Effect.fn("Permission.reply")((input: PermissionV1.ReplyInput) =>
      gate.withPermit(
        Effect.gen(function* () {
          const { approved, pending } = yield* InstanceState.get(state)
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

          pending.delete(input.requestID)
          yield* events.publish(Event.Replied, {
            sessionID: existing.info.sessionID,
            requestID: existing.info.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message
                ? new PermissionV1.CorrectedError({ feedback: input.message })
                : new PermissionV1.RejectedError(),
            )

            for (const [id, item] of pending.entries()) {
              if (item.info.sessionID !== existing.info.sessionID) continue
              pending.delete(id)
              yield* events.publish(Event.Replied, {
                sessionID: item.info.sessionID,
                requestID: item.info.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            return
          }

          yield* Deferred.succeed(existing.deferred, undefined)
          if (input.reply === "once") return

          for (const pattern of existing.info.always) {
            approved.push({
              permission: existing.info.permission,
              pattern,
              action: "allow",
            })
          }

          for (const [id, item] of pending.entries()) {
            if (item.info.sessionID !== existing.info.sessionID) continue
            const ok = item.info.patterns.every(
              (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
            )
            if (!ok) continue
            pending.delete(id)
            yield* events.publish(Event.Replied, {
              sessionID: item.info.sessionID,
              requestID: item.info.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
          }
        }),
      ),
    )

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    const unsubscribe = yield* coreEvents.listen((event) =>
      event.type === SessionEvent.PermissionModeChanged.type
        ? gate.withPermit(
            Effect.gen(function* () {
              for (const state of states) {
                yield* Effect.forEach(
                  state.pending.values(),
                  (item) =>
                    SessionPermissionMode.affectedBy(
                      db,
                      SessionV2.ID.make(item.info.sessionID),
                      (event.data as { sessionID: SessionV2.ID }).sessionID,
                    ).pipe(
                      Effect.flatMap((affected) =>
                        affected
                          ? settleMode(state, item, (definition, data, options) =>
                              coreEvents.publish(definition, data, { ...options, location: state.location }),
                            )
                          : Effect.void,
                      ),
                    ),
                  { discard: true },
                )
              }
            }),
          )
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(
  tools: string[],
  ruleset: PermissionV1.Ruleset,
  permissionMode: PermissionMode = "default",
): Set<string> {
  if (permissionMode === "full") return new Set()
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(
  tools: Record<string, T>,
  ruleset: PermissionV1.Ruleset,
  permissionMode: PermissionMode = "default",
): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset, permissionMode)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, EventV2.node, Database.node],
})

export * as Permission from "."
