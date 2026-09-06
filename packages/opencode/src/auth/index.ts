import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context, Semaphore } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export type Snapshot = { info: Info | undefined; revision: number }

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly snapshot: (key: string) => Effect.Effect<Snapshot, AuthError>
  readonly compareAndSet: (key: string, expected: Snapshot, info: Info) => Effect.Effect<boolean, AuthError>
  readonly onSelection: (listener: (key: string) => void) => Effect.Effect<() => void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)
    const mutation = Semaphore.makeUnsafe(1)
    const revisions = new Map<string, number>()
    const listeners = new Set<(key: string) => void>()

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info, refreshed = false) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
      revisions.set(norm, (revisions.get(norm) ?? 0) + 1)
      if (!refreshed) listeners.forEach((listener) => listener(norm))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
      revisions.set(norm, (revisions.get(norm) ?? 0) + 1)
      listeners.forEach((listener) => listener(norm))
    })

    return Service.of({
      get,
      all,
      set: (key, info) => mutation.withPermits(1)(set(key, info)),
      remove: (key) => mutation.withPermits(1)(remove(key)),
      snapshot: (key) =>
        mutation.withPermits(1)(
          Effect.gen(function* () {
            return { info: yield* get(key), revision: revisions.get(key) ?? 0 }
          }),
        ),
      compareAndSet: (key, expected, info) =>
        mutation.withPermits(1)(
          Effect.gen(function* () {
            // A logout/relogin is a new selection even when the token bytes match.
            if ((revisions.get(key) ?? 0) !== expected.revision) return false
            if (JSON.stringify(yield* get(key)) !== JSON.stringify(expected.info)) return false
            if (process.env.OPENCODE_AUTH_CONTENT) return false
            yield* set(key, info, true)
            return true
          }),
        ),
      onSelection: (listener) =>
        Effect.sync(() => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
