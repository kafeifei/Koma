import { createHash } from "node:crypto"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionExternalOwnership } from "@opencode-ai/core/session/external/ownership"
import { and, eq, isNull, ne } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema, Scope, Semaphore } from "effect"
import path from "path"
import { Git } from "@/git"
import { InstanceDisposal } from "@/project/instance-disposal"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { WorktreeArchive } from "./archive"

const VERSION = 1 as const
const PREFIX = ["worktree_lifecycle"]

export const Owner = Schema.Struct({
  version: Schema.Literal(VERSION),
  directory: Schema.String,
  root: Schema.String,
  branch: Schema.String,
  projectID: Schema.String,
  sessionID: Schema.optional(Schema.String),
  intent: Schema.optional(Schema.Literals(["archive", "restore", "delete"])),
  phase: Schema.Literals(["registered", "resident", "captured", "removed", "restored", "delete-preserve"]),
  oid: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  updated: Schema.Number,
})
export type Owner = Schema.Schema.Type<typeof Owner>

export class LifecycleFailedError extends Schema.TaggedErrorClass<LifecycleFailedError>()(
  "WorktreeLifecycleFailedError",
  {
    reason: Schema.Literals(["busy", "shared", "conflict", "unavailable", "git", "storage"]),
    message: Schema.String,
    sessionID: Schema.optional(Schema.String),
    directory: Schema.optional(Schema.String),
  },
) {}

export type RegisterInput = {
  readonly directory: string
  readonly root: string
  readonly branch: string
  readonly projectID: string
}

export type ClaimInput = {
  readonly directory: string
  readonly sessionID: string
}

export type ManagedResult = {
  readonly managed: boolean
  readonly pending?: boolean
}

export interface Interface {
  readonly register: (input: RegisterInput) => Effect.Effect<void, LifecycleFailedError>
  readonly claim: (input: ClaimInput) => Effect.Effect<boolean, LifecycleFailedError>
  readonly get: (sessionID: string) => Effect.Effect<Owner | undefined, LifecycleFailedError>
  readonly getDirectory: (directory: string) => Effect.Effect<Owner | undefined, LifecycleFailedError>
  readonly prepareArchive: (sessionID: string) => Effect.Effect<ManagedResult, LifecycleFailedError>
  readonly continueArchive: (sessionID: string) => Effect.Effect<ManagedResult, LifecycleFailedError>
  readonly abortArchive: (sessionID: string) => Effect.Effect<void>
  readonly prepareRestore: (sessionID: string) => Effect.Effect<ManagedResult, LifecycleFailedError>
  readonly finalizeRestore: (sessionID: string) => Effect.Effect<void, LifecycleFailedError>
  readonly prepareDelete: (sessionID: string) => Effect.Effect<ManagedResult, LifecycleFailedError>
  readonly finalizeDelete: (sessionID: string) => Effect.Effect<void, LifecycleFailedError>
  readonly acquire: (input: ClaimInput) => Effect.Effect<void, LifecycleFailedError>
  readonly release: (input: ClaimInput) => Effect.Effect<void>
  readonly withExclusive: <A, E, R>(
    input: { readonly directory: string },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | LifecycleFailedError, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeLifecycle") {}

type Gate = {
  blocked: boolean
  leases: Map<string, number>
  mutation: Semaphore.Semaphore
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const storage = yield* Storage.Service
    const git = yield* Git.Service
    const fs = yield* FSUtil.Service
    const archive = yield* WorktreeArchive.Service
    const disposal = yield* InstanceDisposal.Service
    const externalOwnership = yield* SessionExternalOwnership.Service
    const scope = yield* Scope.Scope
    const gates = new Map<string, Gate>()

    const fail = (
      reason: LifecycleFailedError["reason"],
      message: string,
      owner?: Pick<Owner, "sessionID" | "directory">,
    ) =>
      new LifecycleFailedError({
        reason,
        message,
        sessionID: owner?.sessionID,
        directory: owner?.directory,
      })

    const key = (directory: string) => [...PREFIX, createHash("sha256").update(directory).digest("hex")]

    const decode = Schema.decodeUnknownOption(Owner)
    const readDirectory = Effect.fnUntraced(function* (directory: string) {
      const value = yield* storage.read<unknown>(key(directory)).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        Effect.mapError((error) => fail("storage", error.message, { directory })),
      )
      if (value === undefined) return
      const parsed = decode(value)
      if (Option.isSome(parsed)) return parsed.value
      return yield* fail("storage", "invalid persisted worktree lifecycle record", { directory })
    })

    const records = Effect.fnUntraced(function* () {
      const keys = yield* storage.list(PREFIX).pipe(Effect.mapError((error) => fail("storage", error.message)))
      return yield* Effect.forEach(
        keys,
        (item) =>
          storage.read<unknown>(item).pipe(
            Effect.map((value) => decode(value)),
            Effect.catch(() => Effect.succeed(Option.none<Owner>())),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items) => items.flatMap((item) => (Option.isSome(item) ? [item.value] : []))))
    })

    const get = Effect.fn("WorktreeLifecycle.get")(function* (sessionID: string) {
      return (yield* records()).find((owner) => owner.sessionID === sessionID)
    })

    const getDirectory = Effect.fn("WorktreeLifecycle.getDirectory")(function* (directory: string) {
      return yield* readDirectory(yield* fs.resolve(directory))
    })

    const write = Effect.fnUntraced(function* (owner: Owner) {
      const next = { ...owner, updated: Date.now() } satisfies Owner
      yield* storage
        .writeAtomic(key(owner.directory), next)
        .pipe(Effect.mapError((error) => fail("storage", error.message, owner)))
      return next
    })

    const remove = Effect.fnUntraced(function* (owner: Owner) {
      yield* storage
        .remove(key(owner.directory))
        .pipe(Effect.mapError((error) => fail("storage", error.message, owner)))
    })

    const gate = (directory: string) => {
      const existing = gates.get(directory)
      if (existing) return existing
      const created = { blocked: false, leases: new Map<string, number>(), mutation: Semaphore.makeUnsafe(1) }
      gates.set(directory, created)
      return created
    }

    const mutate = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
      gate(directory).mutation.withPermits(1)(effect)

    const block = (directory: string) =>
      Effect.sync(() => {
        gate(directory).blocked = true
      })

    const unblock = (directory: string) =>
      Effect.sync(() => {
        gate(directory).blocked = false
      })

    const busy = Effect.fnUntraced(function* (owner: Owner) {
      if ([...gate(owner.directory).leases.values()].some((count) => count > 0)) return true
      // Native execution does not own OpenCode runner leases after a backend restart.
      // A persisted binding or an empty inbox is not evidence that its worktree is idle.
      const external = yield* db
        .select({ id: SessionTable.id, directory: SessionTable.directory })
        .from(SessionTable)
        .where(
          and(eq(SessionTable.project_id, ProjectV2.ID.make(owner.projectID)), ne(SessionTable.engine, "opencode")),
        )
        .all()
        .pipe(Effect.orDie)
      for (const session of external) {
        const directory = yield* fs.resolve(session.directory)
        if (directory !== owner.directory && !directory.startsWith(`${owner.directory}${path.sep}`)) continue
        if (!(yield* externalOwnership.isIdle(session.id))) return true
      }
      return false
    })

    const familyShared = Effect.fnUntraced(function* (owner: Owner) {
      if (!owner.sessionID) return false
      const candidates = yield* db
        .select({ id: SessionTable.id, parentID: SessionTable.parent_id, directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.project_id, ProjectV2.ID.make(owner.projectID)))
        .all()
        .pipe(Effect.orDie)
      const rows = (yield* Effect.forEach(
        candidates,
        (row) => fs.resolve(row.directory).pipe(Effect.map((directory) => ({ ...row, directory }))),
        { concurrency: "unbounded" },
      )).filter((row) => row.directory === owner.directory)
      const parents = new Map(candidates.map((row) => [row.id, row.parentID] as const))
      const root = (id: SessionID) => {
        const seen = new Set<SessionID>()
        let current = id
        while (parents.get(current)) {
          if (seen.has(current)) return current
          seen.add(current)
          current = parents.get(current)!
        }
        return current
      }
      return rows.some((row) => root(row.id) !== owner.sessionID)
    })

    const gitRun = Effect.fnUntraced(function* (owner: Owner, args: string[]) {
      const result = yield* git.run(args, { cwd: owner.root })
      if (result.exitCode === 0) return result.text().trim()
      const message = result.stderr.toString("utf8").trim() || result.text().trim() || `exit ${result.exitCode}`
      return yield* fail("git", `git ${args[0]} failed: ${message}`, owner)
    })

    const ref = (owner: Owner) => `refs/opencode/worktree-archive/${owner.sessionID}`

    const verifyArchive = Effect.fnUntraced(function* (owner: Owner) {
      if (!owner.oid || !owner.sessionID) return yield* fail("conflict", "archive snapshot oid is missing", owner)
      const result = yield* git.run(["rev-parse", "--verify", "--quiet", ref(owner)], { cwd: owner.root })
      if (result.exitCode === 0 && result.text().trim() === owner.oid) return
      return yield* fail("conflict", "archive snapshot ref no longer matches its persisted oid", owner)
    })

    const directoryExists = (owner: Owner) => fs.existsSafe(owner.directory)

    const removeCheckout = Effect.fnUntraced(function* (owner: Owner) {
      const list = yield* gitRun(owner, ["worktree", "list", "--porcelain"])
      const entries = yield* Effect.forEach(
        list.split(/\r?\n\r?\n/).filter(Boolean),
        (block) =>
          Effect.gen(function* () {
            const lines = block.split(/\r?\n/)
            const worktree = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
            if (!worktree) return
            return {
              directory: yield* fs.resolve(worktree),
              branch: lines.find((line) => line.startsWith("branch "))?.slice("branch refs/heads/".length),
            }
          }),
        { concurrency: "unbounded" },
      )
      const registered = entries.find((entry) => entry?.directory === owner.directory)
      const exists = yield* directoryExists(owner)
      if (exists && !registered) {
        return yield* fail("conflict", "managed worktree path is no longer registered; directory was preserved", owner)
      }
      if (registered && registered.branch !== owner.branch) {
        return yield* fail("conflict", "managed worktree branch identity changed; directory was preserved", owner)
      }
      if (registered || exists) {
        yield* disposal
          .disposeDirectory(owner.directory)
          .pipe(
            Effect.mapError(() =>
              fail("unavailable", "instance cache owner is unavailable; checkout was preserved", owner),
            ),
          )
      }
      if (registered) {
        const result = yield* git.run(["worktree", "remove", "--force", owner.directory], { cwd: owner.root })
        if (result.exitCode !== 0) {
          const current = yield* gitRun(owner, ["worktree", "list", "--porcelain"])
          if (current.split(/\r?\n/).some((line) => line === `worktree ${owner.directory}`)) {
            const message = result.stderr.toString("utf8").trim() || result.text().trim()
            return yield* fail("git", `failed to remove managed worktree: ${message}`, owner)
          }
        }
      }
      if (yield* directoryExists(owner)) {
        yield* fs
          .remove(owner.directory, { recursive: true, force: true })
          .pipe(Effect.mapError((error) => fail("unavailable", error.message, owner)))
      }
      if (yield* directoryExists(owner))
        return yield* fail("unavailable", "managed worktree directory still exists", owner)
    })

    const capture = Effect.fnUntraced(function* (owner: Owner) {
      if (owner.oid) {
        yield* verifyArchive(owner)
        return owner
      }
      if (!owner.sessionID) return yield* fail("conflict", "managed worktree has no owning session", owner)
      const result = yield* archive
        .capture({ directory: owner.directory, branch: owner.branch, sessionID: owner.sessionID })
        .pipe(Effect.mapError((error) => fail("git", error.message, owner)))
      return yield* write({ ...owner, phase: "captured", oid: result.oid, lastError: undefined })
    })

    const persistFailure = Effect.fnUntraced(function* (owner: Owner, error: LifecycleFailedError) {
      yield* readDirectory(owner.directory).pipe(
        Effect.flatMap((current) => (current ? write({ ...current, lastError: error.message }) : Effect.void)),
        Effect.ignore,
      )
      return yield* error
    })

    const register = Effect.fn("WorktreeLifecycle.register")(function* (input: RegisterInput) {
      const directory = yield* fs.resolve(input.directory)
      const root = yield* fs.resolve(input.root)
      yield* mutate(
        directory,
        Effect.gen(function* () {
          if (gate(directory).blocked)
            return yield* fail("busy", "worktree directory is currently in use", { directory })
          const existing = yield* readDirectory(directory)
          if (existing) {
            if (existing.root === root && existing.branch === input.branch && existing.projectID === input.projectID)
              return
            return yield* fail(
              "conflict",
              "worktree directory is already registered to another lifecycle owner",
              existing,
            )
          }
          yield* write({
            version: VERSION,
            directory,
            root,
            branch: input.branch,
            projectID: input.projectID,
            phase: "registered",
            updated: Date.now(),
          })
        }),
      )
    })

    const claim = Effect.fn("WorktreeLifecycle.claim")(function* (input: ClaimInput) {
      const directory = yield* fs.resolve(input.directory)
      return yield* mutate(
        directory,
        Effect.gen(function* () {
          if (gate(directory).blocked)
            return yield* fail("busy", "worktree directory is currently in use", { directory })
          const owner = yield* readDirectory(directory)
          if (!owner) return false
          if (owner.sessionID) return owner.sessionID === input.sessionID
          const session = yield* db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.id, SessionID.make(input.sessionID)),
                eq(SessionTable.directory, directory),
                isNull(SessionTable.parent_id),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!session) return false
          yield* write({ ...owner, sessionID: input.sessionID, phase: "resident", lastError: undefined })
          return true
        }),
      )
    })

    const prepareArchive = Effect.fn("WorktreeLifecycle.prepareArchive")(function* (sessionID: string) {
      const owner = yield* get(sessionID)
      if (!owner) return { managed: false }
      return yield* mutate(
        owner.directory,
        Effect.gen(function* () {
          const current = yield* get(sessionID)
          if (!current) return { managed: false }
          if (current.intent && current.intent !== "archive") {
            return yield* fail("busy", `worktree has a pending ${current.intent} request`, current)
          }
          if (yield* familyShared(current)) return { managed: false }
          yield* block(current.directory)
          yield* write({ ...current, intent: "archive", lastError: undefined }).pipe(
            Effect.onError(() => unblock(current.directory)),
          )
          return { managed: true, pending: yield* busy(current) }
        }),
      )
    })

    const continueArchive = Effect.fn("WorktreeLifecycle.continueArchive")(function* (sessionID: string) {
      const owner = yield* get(sessionID)
      if (!owner) return { managed: false }
      return yield* mutate(
        owner.directory,
        Effect.gen(function* () {
          const current = yield* get(sessionID)
          if (!current || current.intent !== "archive") return { managed: !!current }
          if (current.phase === "removed") return { managed: true }
          if (yield* busy(current)) return { managed: true, pending: true }
          const row = yield* db
            .select({ archived: SessionTable.time_archived })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionID.make(sessionID)))
            .get()
            .pipe(Effect.orDie)
          if (!row?.archived) return { managed: true, pending: true }

          return yield* Effect.gen(function* () {
            const captured = (yield* directoryExists(current)) ? yield* capture(current) : current
            yield* verifyArchive(captured)
            yield* removeCheckout(captured)
            yield* write({ ...captured, phase: "removed", lastError: undefined })
            return { managed: true }
          }).pipe(Effect.catch((error) => persistFailure(current, error)))
        }),
      )
    })

    const abortArchive = Effect.fn("WorktreeLifecycle.abortArchive")(function* (sessionID: string) {
      const owner = yield* get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!owner) return
      yield* mutate(
        owner.directory,
        Effect.gen(function* () {
          const current = yield* get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!current || current.intent !== "archive" || current.phase !== "resident") return
          const cleared = yield* write({ ...current, intent: undefined, lastError: undefined }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (!cleared) return
          yield* unblock(current.directory)
        }),
      )
    })

    const prepareRestore = Effect.fn("WorktreeLifecycle.prepareRestore")(function* (sessionID: string) {
      const owner = yield* get(sessionID)
      if (!owner) return { managed: false }
      return yield* mutate(
        owner.directory,
        Effect.gen(function* () {
          const current = yield* get(sessionID)
          if (!current) return { managed: false }
          if (!current.oid && current.phase === "resident" && !current.intent) return { managed: true }
          if (current.intent === "delete") {
            return yield* fail("busy", "worktree has a pending delete request", current)
          }
          if (current.intent === "archive" && current.phase !== "removed") {
            return yield* fail("busy", "worktree archive has not finished removing the checkout", current)
          }
          yield* block(current.directory)
          const planned = yield* write({ ...current, intent: "restore", lastError: undefined }).pipe(
            Effect.onError(() => unblock(current.directory)),
          )
          return yield* Effect.gen(function* () {
            if (planned.phase !== "restored") yield* verifyArchive(planned)
            if (!(yield* directoryExists(planned))) {
              yield* fs
                .makeDirectory(path.dirname(planned.directory), { recursive: true })
                .pipe(Effect.mapError((error) => fail("unavailable", error.message, planned)))
              yield* gitRun(planned, ["worktree", "add", planned.directory, planned.branch])
            }
            yield* archive
              .restore({ directory: planned.directory, branch: planned.branch, sessionID, oid: planned.oid! })
              .pipe(Effect.mapError((error) => fail("git", error.message, planned)))
            yield* write({ ...planned, phase: "restored", lastError: undefined })
            return { managed: true }
          }).pipe(Effect.catch((error) => persistFailure(planned, error)))
        }),
      )
    })

    const finalizeRestore = Effect.fn("WorktreeLifecycle.finalizeRestore")(function* (sessionID: string) {
      const owner = yield* get(sessionID)
      if (!owner) return
      yield* mutate(
        owner.directory,
        Effect.gen(function* () {
          const current = yield* get(sessionID)
          if (!current || current.intent !== "restore" || current.phase !== "restored" || !current.oid) return
          yield* archive
            .clear({ directory: current.root, sessionID, oid: current.oid })
            .pipe(Effect.mapError((error) => fail("git", error.message, current)))
          yield* write({ ...current, intent: undefined, phase: "resident", oid: undefined, lastError: undefined })
          yield* unblock(current.directory)
        }),
      )
    })

    const prepareDelete = Effect.fn("WorktreeLifecycle.prepareDelete")(function* (sessionID: string) {
      const owner = yield* get(sessionID)
      if (!owner) return { managed: false }
      return yield* mutate(
        owner.directory,
        Effect.gen(function* () {
          const current = yield* get(sessionID)
          if (!current) return { managed: false }
          if (current.intent === "restore") {
            return yield* fail("busy", "worktree has a pending restore request", current)
          }
          if (current.intent === "archive" && current.phase !== "removed") {
            return yield* fail("busy", "worktree archive has not finished removing the checkout", current)
          }
          const shared = yield* familyShared(current)
          if (yield* busy(current)) {
            return yield* fail("busy", "session or a background child is still using the worktree", current)
          }
          yield* block(current.directory)
          const planned = yield* write({
            ...current,
            intent: "delete",
            phase: shared ? "delete-preserve" : current.phase,
            lastError: undefined,
          }).pipe(Effect.onError(() => unblock(current.directory)))
          if (shared) return { managed: true }
          yield* capture(planned).pipe(Effect.catch((error) => persistFailure(planned, error)))
          return { managed: true }
        }),
      )
    })

    const finalizeDelete = Effect.fn("WorktreeLifecycle.finalizeDelete")(function* (sessionID: string) {
      const owner = yield* get(sessionID)
      if (!owner) return
      return yield* mutate(
        owner.directory,
        Effect.gen(function* () {
          const current = yield* get(sessionID)
          if (!current || current.intent !== "delete") return
          const session = yield* db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionID.make(sessionID)))
            .get()
            .pipe(Effect.orDie)
          if (session) return yield* fail("conflict", "session still exists; managed checkout was preserved", current)
          if (current.phase === "delete-preserve") {
            yield* remove(current)
            yield* unblock(current.directory)
            return
          }
          return yield* Effect.gen(function* () {
            yield* removeCheckout(current)
            const upstream = yield* gitRun(current, [
              "for-each-ref",
              "--format=%(upstream)",
              `refs/heads/${current.branch}`,
            ])
            if (!upstream) {
              const branch = yield* git.run(["show-ref", "--verify", "--quiet", `refs/heads/${current.branch}`], {
                cwd: current.root,
              })
              if (branch.exitCode === 0) yield* gitRun(current, ["branch", "-D", "--", current.branch])
            }
            yield* archive
              .clear({ directory: current.root, sessionID, oid: current.oid! })
              .pipe(Effect.mapError((error) => fail("git", error.message, current)))
            yield* remove(current)
            yield* unblock(current.directory)
          }).pipe(Effect.catch((error) => persistFailure(current, error)))
        }),
      )
    })

    const acquire = Effect.fn("WorktreeLifecycle.acquire")(function* (input: ClaimInput) {
      const directory = yield* fs.resolve(input.directory)
      yield* mutate(
        directory,
        Effect.gen(function* () {
          const current = gate(directory)
          if (current.blocked) {
            return yield* fail("busy", "worktree has a pending archive, restore, or delete request", {
              directory,
              sessionID: input.sessionID,
            })
          }
          current.leases.set(input.sessionID, (current.leases.get(input.sessionID) ?? 0) + 1)
        }),
      )
    })

    const release = Effect.fn("WorktreeLifecycle.release")(function* (input: ClaimInput) {
      const directory = yield* fs.resolve(input.directory)
      const retry = yield* mutate(
        directory,
        Effect.gen(function* () {
          const current = gate(directory)
          const count = current.leases.get(input.sessionID) ?? 0
          if (count === 0) return
          if (count === 1) current.leases.delete(input.sessionID)
          if (count > 1) current.leases.set(input.sessionID, count - 1)
          if ([...current.leases.values()].some((value) => value > 0)) return
          const owner = yield* readDirectory(directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (owner?.intent !== "archive" || !owner.sessionID) return
          return owner.sessionID
        }),
      )
      if (!retry) return
      yield* Effect.gen(function* () {
        yield* Effect.yieldNow
        yield* continueArchive(retry).pipe(Effect.catch((error) => Effect.logError("archive retry failed", error)))
      }).pipe(Effect.forkIn(scope))
    })

    const withExclusive: Interface["withExclusive"] = (input, effect) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const directory = yield* fs.resolve(input.directory)
          return yield* mutate(
            directory,
            Effect.gen(function* () {
              const current = gate(directory)
              if (current.blocked || [...current.leases.values()].some((value) => value > 0)) {
                return yield* fail("busy", "worktree directory is currently in use", { directory })
              }
              current.blocked = true
              return directory
            }),
          )
        }),
        (directory) =>
          Effect.gen(function* () {
            const rows = yield* db
              .select({ directory: SessionTable.directory })
              .from(SessionTable)
              .all()
              .pipe(Effect.orDie)
            const session = (yield* Effect.forEach(rows, (row) => fs.resolve(row.directory), {
              concurrency: "unbounded",
            })).some((candidate) => candidate === directory)
            if (!session) return yield* effect
            return yield* fail(
              "shared",
              "worktree directory belongs to a session; use task archive or delete instead",
              {
                directory,
              },
            )
          }),
        (directory) => mutate(directory, unblock(directory)),
      )

    const recovery = yield* records().pipe(Effect.orDie)
    yield* Effect.forEach(
      recovery.filter((owner) => owner.intent !== undefined),
      (owner) => mutate(owner.directory, block(owner.directory)),
      { discard: true },
    )

    const recover = Effect.gen(function* () {
      for (const owner of recovery) {
        if (!owner.intent) continue
        const session = owner.sessionID
          ? yield* db
              .select({ id: SessionTable.id, archived: SessionTable.time_archived })
              .from(SessionTable)
              .where(eq(SessionTable.id, SessionID.make(owner.sessionID)))
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (owner.intent === "archive" && session?.archived && owner.sessionID) {
          yield* continueArchive(owner.sessionID).pipe(
            Effect.catch((error) => Effect.logError("archive recovery failed", error)),
          )
          continue
        }
        if (owner.intent === "archive" && !session?.archived && owner.phase === "resident" && !owner.oid) {
          if (owner.sessionID) {
            yield* abortArchive(owner.sessionID).pipe(
              Effect.catch((error) => Effect.logError("archive recovery rollback failed", error)),
            )
          }
          continue
        }
        if (owner.intent === "delete") {
          if (!session && owner.sessionID) {
            yield* finalizeDelete(owner.sessionID).pipe(
              Effect.catch((error) => Effect.logError("delete recovery failed", error)),
            )
          }
          continue
        }
        if (owner.intent === "restore" && owner.phase === "restored" && !session?.archived && owner.sessionID) {
          yield* finalizeRestore(owner.sessionID).pipe(
            Effect.catch((error) => Effect.logError("restore recovery failed", error)),
          )
          continue
        }
      }
    })
    yield* recover.pipe(
      Effect.catch((error) => Effect.logError("worktree lifecycle recovery failed", error)),
      Effect.forkIn(scope),
    )

    return Service.of({
      register,
      claim,
      get,
      getDirectory,
      prepareArchive,
      continueArchive,
      abortArchive,
      prepareRestore,
      finalizeRestore,
      prepareDelete,
      finalizeDelete,
      acquire,
      release,
      withExclusive,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Database.node,
    Storage.node,
    Git.node,
    FSUtil.node,
    WorktreeArchive.node,
    InstanceDisposal.node,
    SessionExternalOwnership.node,
  ],
})

export * as WorktreeLifecycle from "./lifecycle"
