import { createHash } from "node:crypto"
import { StorageDirectory } from "@opencode-ai/core/storage-directory"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { EventV2 } from "@opencode-ai/core/event"
import { Config } from "@opencode-ai/core/config"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { DirectoryLease } from "@opencode-ai/core/directory-lease"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LocationServiceMap, buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { node } from "@opencode-ai/core/session/runner/llm"
import { SessionStore } from "@opencode-ai/core/session/store"
import { WorktreeRuntime } from "../../src/worktree/runtime"
import { $ } from "bun"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionExternalOwnership } from "@opencode-ai/core/session/external/ownership"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { InstanceDisposal } from "../../src/project/instance-disposal"
import { SessionID } from "../../src/session/schema"
import { Storage } from "../../src/storage/storage"
import { WorktreeLifecycle } from "../../src/worktree/lifecycle"
import { WorktreeArchive } from "../../src/worktree/archive"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      WorktreeLifecycle.node,
      SessionStore.node,
      WorktreeArchive.node,
      InstanceDisposal.node,
      Storage.node,
      Database.node,
      Git.node,
      SessionExternalOwnership.node,
    ]),
  ),
)

const scopedTmpdir = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir({ git: true })),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const git = Effect.fn("WorktreeLifecycleTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().nothrow())
  if (result.exitCode !== 0) {
    return yield* Effect.fail(new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`))
  }
  return result.text().trim()
})

const exists = (target: string) =>
  Effect.promise(() =>
    fs
      .stat(target)
      .then(() => true)
      .catch(() => false),
  )

const fixture = Effect.fn("WorktreeLifecycleTest.fixture")(function* (directoryForRoot?: (root: string) => string) {
  const root = yield* scopedTmpdir()
  yield* Effect.promise(() => Bun.write(path.join(root.path, "tracked.txt"), "base\n"))
  yield* git(root.path, ["add", "tracked.txt"])
  yield* git(root.path, ["commit", "--no-gpg-sign", "-m", "lifecycle base"])

  const sessionID = SessionID.descending()
  const projectID = ProjectV2.ID.make(`lifecycle-${crypto.randomUUID()}`)
  const branch = `opencode/lifecycle-${crypto.randomUUID().slice(0, 8)}`
  const directory =
    directoryForRoot?.(root.path) ?? path.join(path.dirname(root.path), `opencode-lifecycle-${crypto.randomUUID()}`)
  yield* git(root.path, ["worktree", "add", "-b", branch, directory, "HEAD"])
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await $`git worktree remove --force ${directory}`.cwd(root.path).quiet().nothrow()
      await fs.rm(directory, { recursive: true, force: true })
    }),
  )

  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db
    .insert(ProjectTable)
    .values({
      id: projectID,
      worktree: AbsolutePath.make(root.path),
      vcs: "git",
      time_created: now,
      time_updated: now,
      sandboxes: [AbsolutePath.make(directory)],
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug: sessionID,
      directory,
      title: "lifecycle test",
      version: "0.0.0-test",
      time_created: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
  yield* Effect.addFinalizer(() =>
    db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run().pipe(Effect.orDie),
  )

  const lifecycle = yield* WorktreeLifecycle.Service
  const disposal = yield* InstanceDisposal.Service
  yield* disposal.register(() => Effect.void)
  yield* lifecycle.register({ directory, root: root.path, branch, projectID })
  expect(yield* lifecycle.claim({ directory, sessionID })).toBe(true)
  const storage = yield* Storage.Service
  yield* Effect.addFinalizer(() =>
    storage
      .remove(["worktree_lifecycle", new Bun.CryptoHasher("sha256").update(directory).digest("hex")])
      .pipe(Effect.ignore),
  )
  return { branch, db, directory, lifecycle, projectID, root: root.path, sessionID }
})

describe("WorktreeLifecycle", () => {
  it.live("preserves external worktrees until the current native owner confirms idle", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const ownership = yield* SessionExternalOwnership.Service
      yield* input.db
        .update(SessionTable)
        .set({ engine: "codex" })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* input.lifecycle.prepareArchive(input.sessionID)).toEqual({ managed: true, pending: true })
      yield* input.db
        .update(SessionTable)
        .set({ time_archived: Date.now() })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* input.lifecycle.continueArchive(input.sessionID)).toEqual({ managed: true, pending: true })
      expect(yield* exists(input.directory)).toBe(true)

      yield* ownership.beginGeneration("home", "old-host:1")
      yield* ownership.confirmIdle({ runtimeScope: "home", generation: "old-host:1", sessionID: input.sessionID })
      yield* ownership.beginGeneration("home", "new-host:1")
      expect(yield* input.lifecycle.continueArchive(input.sessionID)).toEqual({ managed: true, pending: true })
      yield* ownership.confirmIdle({ runtimeScope: "home", generation: "new-host:1", sessionID: input.sessionID })
      expect(yield* input.lifecycle.continueArchive(input.sessionID)).toEqual({ managed: true })
      expect(yield* exists(input.directory)).toBe(false)
    }),
  )

  it.live("directory manager gates retain external ownership across backend generations", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const ownership = yield* SessionExternalOwnership.Service
      const nested = `${input.directory}/nested`
      yield* Effect.promise(() => fs.mkdir(nested))
      yield* input.db
        .update(SessionTable)
        .set({ engine: "codex" })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toEqual([])
      const unknown = yield* input.lifecycle.withIdleDirectory(nested, Effect.void).pipe(Effect.flip)
      expect(unknown.reason).toBe("busy")
      const exclusive = yield* input.lifecycle.withExclusive({ directory: nested }, Effect.void).pipe(Effect.flip)
      expect(exclusive.reason).toBe("busy")
      yield* ownership.beginGeneration("manager-home", "old-host:1")
      yield* ownership.confirmIdle({
        runtimeScope: "manager-home",
        generation: "old-host:1",
        sessionID: input.sessionID,
      })
      yield* ownership.beginGeneration("manager-home", "new-host:1")
      const recovered = yield* input.lifecycle.withIdleDirectory(input.directory, Effect.void).pipe(Effect.flip)
      expect(recovered.reason).toBe("busy")
      yield* ownership.confirmIdle({
        runtimeScope: "manager-home",
        generation: "new-host:1",
        sessionID: input.sessionID,
      })
      yield* input.lifecycle.withIdleDirectory(nested, Effect.void)
      yield* input.lifecycle.withExclusive({ directory: nested }, Effect.void)
    }),
  )

  it.live("preserves a parent checkout while an external child has unknown execution state", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const ownership = yield* SessionExternalOwnership.Service
      const child = SessionID.descending()
      yield* input.db
        .insert(SessionTable)
        .values({
          id: child,
          engine: "codex",
          project_id: input.projectID,
          parent_id: input.sessionID,
          slug: child,
          directory: input.directory,
          title: "native child",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* input.lifecycle.prepareArchive(input.sessionID)).toEqual({ managed: true, pending: true })
      yield* input.db
        .update(SessionTable)
        .set({ time_archived: Date.now() })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* input.lifecycle.continueArchive(input.sessionID)).toEqual({ managed: true, pending: true })
      expect(yield* exists(input.directory)).toBe(true)
      yield* ownership.beginGeneration("home", "host:1")
      yield* ownership.confirmIdle({ runtimeScope: "home", generation: "host:1", sessionID: child })
      expect(yield* input.lifecycle.continueArchive(input.sessionID)).toEqual({ managed: true })
      expect(yield* exists(input.directory)).toBe(false)
    }),
  )

  it.live("uses one lease identity through a symlinked directory path", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const alias = `${input.directory}-alias`
      yield* Effect.promise(() => fs.symlink(input.directory, alias))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(alias, { force: true })))

      yield* input.lifecycle.acquire({ directory: alias, sessionID: input.sessionID })
      const error = yield* input.lifecycle.withExclusive({ directory: input.directory }, Effect.void).pipe(Effect.flip)
      expect(error.reason).toBe("busy")
      yield* input.lifecycle.release({ directory: alias, sessionID: input.sessionID })
    }),
  )

  it.live("protects an idle session whose persisted directory is a symlink alias", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const alias = `${input.directory}-persisted-alias`
      yield* Effect.promise(() => fs.symlink(input.directory, alias))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(alias, { force: true })))
      yield* input.db
        .update(SessionTable)
        .set({ directory: alias })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)

      const error = yield* input.lifecycle.withExclusive({ directory: input.directory }, Effect.void).pipe(Effect.flip)

      expect(error.reason).toBe("shared")
      expect(yield* exists(input.directory)).toBe(true)
    }),
  )

  it.live("queues archive behind the runner lease and removes after release", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "tracked.txt"), "working\n"))
      yield* input.lifecycle.acquire({ directory: input.directory, sessionID: input.sessionID })

      expect(yield* input.lifecycle.prepareArchive(input.sessionID)).toEqual({ managed: true, pending: true })
      yield* input.db
        .update(SessionTable)
        .set({ time_archived: Date.now() })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* input.lifecycle.continueArchive(input.sessionID)).toEqual({ managed: true, pending: true })
      expect(yield* exists(input.directory)).toBe(true)

      yield* input.lifecycle.release({ directory: input.directory, sessionID: input.sessionID })
      const owner = yield* pollWithTimeout(
        input.lifecycle
          .get(input.sessionID)
          .pipe(Effect.map((value) => (value?.phase === "removed" ? value : undefined))),
        "archive did not finish after the runner released its lease",
      )
      expect(owner.oid).toMatch(/^[0-9a-f]{40,64}$/)
      expect(yield* exists(input.directory)).toBe(false)
    }),
  )

  it.live("keeps the checkout while a child lease remains after its parent releases", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const child = SessionID.descending()
      yield* input.lifecycle.acquire({ directory: input.directory, sessionID: input.sessionID })
      yield* input.lifecycle.acquire({ directory: input.directory, sessionID: child })
      expect(yield* input.lifecycle.prepareArchive(input.sessionID)).toEqual({ managed: true, pending: true })
      yield* input.db
        .update(SessionTable)
        .set({ time_archived: Date.now() })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)

      yield* input.lifecycle.release({ directory: input.directory, sessionID: input.sessionID })
      yield* Effect.sleep("20 millis")
      expect(yield* exists(input.directory)).toBe(true)
      expect(yield* input.lifecycle.get(input.sessionID)).toMatchObject({ phase: "resident" })

      yield* input.lifecycle.release({ directory: input.directory, sessionID: child })
      yield* pollWithTimeout(
        input.lifecycle
          .get(input.sessionID)
          .pipe(Effect.map((owner) => (owner?.phase === "removed" ? owner : undefined))),
        "archive did not finish after the child lease released",
      )
      expect(yield* exists(input.directory)).toBe(false)
    }),
  )

  it.live("restores the persisted staged and working state after checkout removal", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "tracked.txt"), "staged\n"))
      yield* git(input.directory, ["add", "tracked.txt"])
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "tracked.txt"), "working\n"))
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "untracked.txt"), "untracked\n"))

      yield* input.lifecycle.prepareArchive(input.sessionID)
      yield* input.db
        .update(SessionTable)
        .set({ time_archived: Date.now() })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* input.lifecycle.continueArchive(input.sessionID)

      yield* input.lifecycle.prepareRestore(input.sessionID)
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "tracked.txt")).text())).toBe("working\n")
      expect(yield* git(input.directory, ["diff", "--cached", "--", "tracked.txt"])).toContain("+staged")
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "untracked.txt")).text())).toBe(
        "untracked\n",
      )
      yield* input.db
        .update(SessionTable)
        .set({ time_archived: null })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* input.lifecycle.finalizeRestore(input.sessionID)

      expect(yield* input.lifecycle.get(input.sessionID)).toMatchObject({ phase: "resident" })
      yield* input.lifecycle.acquire({ directory: input.directory, sessionID: input.sessionID })
      yield* input.lifecycle.release({ directory: input.directory, sessionID: input.sessionID })
    }),
  )

  it.live("serializes a rapid archive and restore without double-removing the checkout", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* Effect.promise(() => Bun.write(path.join(input.directory, "tracked.txt"), "rapid\n"))
      yield* input.lifecycle.prepareArchive(input.sessionID)
      yield* input.db
        .update(SessionTable)
        .set({ time_archived: Date.now() })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)

      const results = yield* Effect.all(
        {
          archive: input.lifecycle.continueArchive(input.sessionID),
          restore: input.lifecycle
            .prepareRestore(input.sessionID)
            .pipe(
              Effect.catchTag("WorktreeLifecycleFailedError", (error) =>
                error.reason === "busy" ? Effect.succeed({ busy: true }) : Effect.fail(error),
              ),
            ),
        },
        { concurrency: "unbounded" },
      )
      expect(results.archive.managed).toBe(true)
      // Restore may reach the mutex first; its busy response must be safely retryable after archive completes.
      const restored =
        "busy" in results.restore ? yield* input.lifecycle.prepareRestore(input.sessionID) : results.restore
      expect(restored.managed).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(input.directory, "tracked.txt")).text())).toBe("rapid\n")
      expect(yield* input.lifecycle.get(input.sessionID)).toMatchObject({ intent: "restore", phase: "restored" })

      yield* input.db
        .update(SessionTable)
        .set({ time_archived: null })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* Effect.all(
        [input.lifecycle.finalizeRestore(input.sessionID), input.lifecycle.finalizeRestore(input.sessionID)],
        { concurrency: "unbounded", discard: true },
      )
      expect(yield* input.lifecycle.get(input.sessionID)).toMatchObject({ phase: "resident" })
    }),
  )

  it.live("preserves a shared checkout when another root session uses the directory", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const other = SessionID.descending()
      const alias = `${input.directory}-shared-alias`
      yield* Effect.promise(() => fs.symlink(input.directory, alias))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(alias, { force: true })))
      const now = Date.now()
      yield* input.db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: input.projectID,
          slug: other,
          directory: alias,
          title: "other root",
          version: "0.0.0-test",
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* input.lifecycle.prepareArchive(input.sessionID)).toEqual({ managed: false })
      expect(yield* exists(input.directory)).toBe(true)
      yield* input.lifecycle.acquire({ directory: input.directory, sessionID: input.sessionID })
      yield* input.lifecycle.release({ directory: input.directory, sessionID: input.sessionID })
      yield* input.lifecycle.acquire({ directory: alias, sessionID: other })
      yield* input.lifecycle.release({ directory: alias, sessionID: other })
    }),
  )

  it.live("preserves an owned branch that has an upstream when the task is deleted", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const base = yield* git(input.root, ["branch", "--show-current"])
      yield* git(input.directory, ["branch", "--set-upstream-to", base, input.branch])

      yield* input.lifecycle.prepareDelete(input.sessionID)
      yield* input.db.delete(SessionTable).where(eq(SessionTable.id, input.sessionID)).run().pipe(Effect.orDie)
      yield* input.lifecycle.finalizeDelete(input.sessionID)

      expect(yield* input.lifecycle.get(input.sessionID)).toBeUndefined()
      expect(yield* git(input.root, ["show-ref", "--verify", `refs/heads/${input.branch}`])).not.toBe("")
      expect(yield* exists(input.directory)).toBe(false)
    }),
  )

  it.live("preserves a reused worktree path whose branch no longer matches its owner", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      yield* input.lifecycle.prepareDelete(input.sessionID)
      yield* input.db.delete(SessionTable).where(eq(SessionTable.id, input.sessionID)).run().pipe(Effect.orDie)
      yield* git(input.root, ["worktree", "remove", "--force", input.directory])
      const replacement = `opencode/reused-${crypto.randomUUID().slice(0, 8)}`
      yield* git(input.root, ["worktree", "add", "-b", replacement, input.directory, "HEAD"])

      const exit = yield* input.lifecycle.finalizeDelete(input.sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* exists(input.directory)).toBe(true)
      expect(yield* git(input.directory, ["branch", "--show-current"])).toBe(replacement)
      expect(yield* input.lifecycle.get(input.sessionID)).toMatchObject({ intent: "delete" })
    }),
  )
})

it.live("protects the complete V2 drain and rejects startup while a lifecycle operation owns the directory", () =>
  Effect.gen(function* () {
    const input = yield* fixture()
    const store = yield* SessionStore.Service
    const started = yield* Deferred.make<void>()
    const leases = WorktreeRuntime.leases(input.lifecycle)
    const locations = buildLocationServiceMap([
      [DirectoryLease.node, leases],
      [
        node,
        Layer.succeed(
          SessionRunner.Service,
          SessionRunner.Service.of({
            run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
      ],
    ])
    const execution = AppNodeBuilder.build(SessionExecutionLocal.node, [
      [DirectoryLease.node, leases],
      [SessionStore.node, Layer.succeed(SessionStore.Service, store)],
      [LocationServiceMap.node, locations],
    ])
    yield* Effect.gen(function* () {
      const runtime = yield* SessionExecution.Service
      yield* input.lifecycle.withIdleDirectory(
        input.directory,
        Effect.gen(function* () {
          const rejected = yield* runtime.resume(input.sessionID).pipe(Effect.flip)
          expect(rejected._tag).toBe("DirectoryLease.UnavailableError")
          expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toEqual([])
        }),
      )
      const run = yield* runtime.resume(input.sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(started).pipe(Effect.timeout("10 seconds"))
      expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toContain(input.sessionID)
      expect((yield* runtime.active).has(input.sessionID)).toBe(true)
      const blocked = yield* input.lifecycle.withIdleDirectory(input.directory, Effect.void).pipe(Effect.flip)
      expect(blocked.reason).toBe("busy")
      yield* runtime.interrupt(input.sessionID)
      yield* Fiber.await(run)
      expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toEqual([])
      expect((yield* runtime.active).has(input.sessionID)).toBe(false)
    }).pipe(Effect.provide(execution))
  }),
)

it.live("releases PTY leases after exit, removal, rejected creation and Location disposal", () =>
  Effect.gen(function* () {
    const input = yield* fixture()
    const layer = AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
      [DirectoryLease.node, WorktreeRuntime.leases(input.lifecycle)],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make(input.directory) })],
      [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
    ])
    yield* Effect.gen(function* () {
      const pty = yield* Pty.Service
      const created = yield* pty.create({ command: "/bin/cat" })
      expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toEqual([`pty:${created.id}`])
      yield* pty.remove(created.id)
      expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toEqual([])
      const exited = yield* pty.create({ command: "/bin/sh", args: ["-c", "exit 0"] })
      yield* pollWithTimeout(
        input.lifecycle
          .usage(input.directory)
          .pipe(Effect.map((value) => (value.ownerIDs.length === 0 ? true : undefined))),
        "PTY exit retained its lease",
      )
      expect((yield* pty.get(exited.id)).status).toBe("exited")
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === Pty.Event.Created.type ? Effect.die(new Error("failed PTY creation notification")) : Effect.void,
      )
      const failure = yield* pty.create({ command: "/bin/cat" }).pipe(Effect.exit)
      yield* unsubscribe
      expect(Exit.isFailure(failure)).toBe(true)
      expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toEqual([])
      yield* input.lifecycle.withIdleDirectory(
        input.directory,
        Effect.gen(function* () {
          const failed = yield* pty.create({ command: "/bin/cat" }).pipe(Effect.flip)
          expect(failed._tag).toBe("DirectoryLease.UnavailableError")
        }),
      )
      expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toEqual([])
      yield* pty.create({ command: "/bin/cat" })
      expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toHaveLength(1)
    }).pipe(Effect.provide(layer), Effect.scoped)
    expect((yield* input.lifecycle.usage(input.directory)).ownerIDs).toEqual([])
  }),
)

it.live("allows explicit work with historical sessions while protecting parent and child directory leases", () =>
  Effect.gen(function* () {
    const input = yield* fixture()
    const subdir = `${input.root}/nested`
    yield* Effect.promise(() => fs.mkdir(subdir))
    yield* input.lifecycle.acquire({ directory: subdir, sessionID: "pty:child" })
    const parent = yield* input.lifecycle.withIdleDirectory(input.root, Effect.void).pipe(Effect.flip)
    expect(parent.reason).toBe("busy")
    expect((yield* input.lifecycle.usage(input.root)).ownerIDs).toContain("pty:child")
    yield* input.lifecycle.release({ directory: subdir, sessionID: "pty:child" })
    yield* input.lifecycle.withIdleDirectory(
      input.root,
      Effect.gen(function* () {
        const child = yield* input.lifecycle.acquire({ directory: subdir, sessionID: "pty:child" }).pipe(Effect.flip)
        expect(child.reason).toBe("busy")
      }),
    )
    expect(
      yield* input.lifecycle.withIdleDirectory(input.directory, Effect.succeed("historical session is allowed")),
    ).toBe("historical session is allowed")
  }),
)

it.live("preserves files changed externally after a persisted archive capture", () =>
  Effect.gen(function* () {
    const input = yield* fixture()
    const archive = yield* WorktreeArchive.Service
    const storage = yield* Storage.Service
    yield* input.lifecycle.prepareArchive(input.sessionID)
    yield* input.db
      .update(SessionTable)
      .set({ time_archived: Date.now() })
      .where(eq(SessionTable.id, input.sessionID))
      .run()
      .pipe(Effect.orDie)
    const saved = yield* archive.capture({
      directory: input.directory,
      branch: input.branch,
      sessionID: input.sessionID,
    })
    const owner = yield* input.lifecycle.get(input.sessionID)
    yield* storage.writeAtomic(["worktree_lifecycle", createHash("sha256").update(input.directory).digest("hex")], {
      ...owner,
      phase: "captured",
      oid: saved.oid,
    })
    yield* Effect.promise(() => fs.writeFile(`${input.directory}/tracked.txt`, "external writer after capture"))
    const failed = yield* input.lifecycle.continueArchive(input.sessionID).pipe(Effect.flip)
    expect(failed.reason).toBe("git")
    expect(yield* Effect.promise(() => fs.readFile(`${input.directory}/tracked.txt`, "utf8"))).toBe(
      "external writer after capture",
    )
    expect(yield* git(input.root, ["rev-parse", `refs/opencode/worktree-archive/${input.sessionID}`])).toBe(saved.oid)
  }),
)

it.live("repairs a proven legacy linked root before removing its checkout", () =>
  Effect.gen(function* () {
    const input = yield* fixture()
    const storage = yield* Storage.Service
    const key = ["worktree_lifecycle", createHash("sha256").update(input.directory).digest("hex")]
    const owner = yield* input.lifecycle.get(input.sessionID)
    yield* storage.writeAtomic(key, { ...owner, root: input.directory })
    expect((yield* input.lifecycle.get(input.sessionID))?.root).toBe(input.root)
    expect((yield* storage.read<WorktreeLifecycle.Owner>(key)).root).toBe(input.directory)
    yield* input.lifecycle.prepareArchive(input.sessionID)
    expect((yield* storage.read<WorktreeLifecycle.Owner>(key)).root).toBe(input.root)
    yield* input.db
      .update(SessionTable)
      .set({ time_archived: Date.now() })
      .where(eq(SessionTable.id, input.sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* input.lifecycle.continueArchive(input.sessionID)
    expect(yield* exists(input.directory)).toBe(false)
    yield* input.lifecycle.prepareRestore(input.sessionID)
    expect(yield* exists(input.directory)).toBe(true)
    const forbidden = yield* input.lifecycle
      .register({ directory: input.root, root: input.root, branch: "main", projectID: input.projectID })
      .pipe(Effect.flip)
    expect(forbidden.reason).toBe("conflict")
  }),
)

it.live("restores an archived checkout after completed-home identity repair and retains lifecycle ownership", () =>
  Effect.gen(function* () {
    const environment = process.env.OPENCODE_HOME
    delete process.env.OPENCODE_HOME
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (environment === undefined) delete process.env.OPENCODE_HOME
        else process.env.OPENCODE_HOME = environment
      }),
    )
    const input = yield* fixture((root) => path.join(root, "legacy/backend/data/opencode/worktree/project/task"))
    const legacyRoot = path.join(input.root, "legacy")
    const root = path.join(input.root, "unified")
    const physical = path.join(root, "worktrees/project/task")
    yield* Effect.promise(() => fs.writeFile(path.join(input.directory, "tracked.txt"), "saved before migration\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(input.directory, "untracked.txt"), "untracked retained\n"))
    yield* input.lifecycle.prepareArchive(input.sessionID)
    yield* input.db
      .update(SessionTable)
      .set({ time_archived: Date.now() })
      .where(eq(SessionTable.id, input.sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* input.lifecycle.continueArchive(input.sessionID)
    expect(yield* exists(input.directory)).toBe(false)
    const owner = yield* input.lifecycle.get(input.sessionID)
    expect(owner?.phase).toBe("removed")
    // The fixture runtime uses its own database/storage service. Supply its actual persisted owner to the migration fixture.
    yield* Effect.promise(() =>
      Bun.write(
        path.join(
          legacyRoot,
          "backend/data/opencode/storage/worktree_lifecycle",
          createHash("sha256").update(input.directory).digest("hex") + ".json",
        ),
        JSON.stringify(owner),
      ),
    )
    yield* Effect.acquireRelease(
      Effect.promise(() => StorageMigration.lock(root)),
      (lease) => Effect.promise(() => lease.release()),
    )
    yield* Effect.sync(() => StorageMigration.prepareUnifiedHome({ root, legacyRoot, acquireLock: () => true }))
    const metadata = path.join(root, "storage.json")
    const manifest = yield* Effect.promise(() => Bun.file(metadata).json())
    // Reproduce a home already migrated by the previous release, when this removed checkout was omitted.
    yield* Effect.promise(() => Bun.write(metadata, JSON.stringify({ ...manifest, worktrees: [] })))
    expect(StorageDirectory.resolve(physical, root)).toBe(physical)
    yield* Effect.sync(() => StorageMigration.reconcileWorktrees({ root, legacyRoot }))
    expect(StorageDirectory.resolve(physical, root)).toBe(input.directory)
    expect(yield* exists(physical)).toBe(false)
    process.env.OPENCODE_HOME = root
    expect((yield* input.lifecycle.getDirectory(physical))?.sessionID).toBe(input.sessionID)
    yield* input.lifecycle.prepareRestore(input.sessionID)
    expect(yield* exists(physical)).toBe(true)
    expect(yield* Effect.promise(() => fs.readFile(path.join(physical, "tracked.txt"), "utf8"))).toBe(
      "saved before migration\n",
    )
    expect(yield* Effect.promise(() => fs.readFile(path.join(physical, "untracked.txt"), "utf8"))).toBe(
      "untracked retained\n",
    )
    expect((yield* input.lifecycle.getDirectory(physical))?.sessionID).toBe(input.sessionID)
    yield* input.db
      .update(SessionTable)
      .set({ time_archived: null })
      .where(eq(SessionTable.id, input.sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* input.lifecycle.finalizeRestore(input.sessionID)
    expect((yield* input.lifecycle.getDirectory(physical))?.phase).toBe("resident")
    expect((yield* input.lifecycle.get(input.sessionID))?.directory).toBe(input.directory)
    yield* input.lifecycle.acquire({ directory: physical, sessionID: input.sessionID })
    expect((yield* input.lifecycle.usage(physical)).ownerIDs).toEqual([input.sessionID])
    yield* input.lifecycle.release({ directory: physical, sessionID: input.sessionID })
    expect((yield* input.lifecycle.usage(physical)).ownerIDs).toEqual([])
    expect(yield* git(physical, ["branch", "--show-current"])).toBe(input.branch)
    const session = yield* input.db
      .select({ directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    expect(session?.directory).toBe(input.directory)

    // Restoring through the compatibility link makes Git register the physical path.
    const restored = yield* git(input.root, ["worktree", "list", "--porcelain", "-z"])
    expect(restored.split("\0")).toContain(`worktree ${physical}`)
    expect(restored.split("\0")).not.toContain(`worktree ${input.directory}`)
    yield* git(input.root, ["worktree", "lock", "--reason", "preserve restored checkout", physical])
    yield* input.lifecycle.prepareArchive(input.sessionID)
    yield* input.db
      .update(SessionTable)
      .set({ time_archived: Date.now() })
      .where(eq(SessionTable.id, input.sessionID))
      .run()
      .pipe(Effect.orDie)
    const failure = yield* input.lifecycle.continueArchive(input.sessionID).pipe(Effect.flip)
    expect(failure.reason).toBe("git")
    expect(failure.message).toContain("locked")
    expect(yield* exists(physical)).toBe(true)
    expect(yield* git(input.root, ["worktree", "list", "--porcelain", "-z"])).toContain(`worktree ${physical}\0`)
    expect((yield* input.lifecycle.getDirectory(physical))?.phase).toBe("captured")
    expect((yield* input.lifecycle.getDirectory(input.directory))?.lastError).toContain("locked")
    expect(yield* Effect.promise(() => fs.readFile(path.join(physical, "tracked.txt"), "utf8"))).toBe(
      "saved before migration\n",
    )

    yield* git(input.root, ["worktree", "unlock", physical])
    yield* input.lifecycle.continueArchive(input.sessionID)
    expect(yield* exists(physical)).toBe(false)
    expect((yield* input.lifecycle.getDirectory(physical))?.phase).toBe("removed")
    expect(yield* git(input.root, ["worktree", "list", "--porcelain", "-z"])).not.toContain(`worktree ${physical}\0`)
    yield* input.lifecycle.prepareRestore(input.sessionID)
    expect(yield* Effect.promise(() => fs.readFile(path.join(physical, "untracked.txt"), "utf8"))).toBe(
      "untracked retained\n",
    )
    yield* input.db
      .update(SessionTable)
      .set({ time_archived: null })
      .where(eq(SessionTable.id, input.sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* input.lifecycle.finalizeRestore(input.sessionID)
    expect((yield* input.lifecycle.list({ projectID: input.projectID })).map((owner) => owner.directory)).toEqual([
      input.directory,
    ])
  }),
)
