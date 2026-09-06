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
import { Effect, Exit } from "effect"
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

const fixture = Effect.fn("WorktreeLifecycleTest.fixture")(function* () {
  const root = yield* scopedTmpdir()
  yield* Effect.promise(() => Bun.write(path.join(root.path, "tracked.txt"), "base\n"))
  yield* git(root.path, ["add", "tracked.txt"])
  yield* git(root.path, ["commit", "--no-gpg-sign", "-m", "lifecycle base"])

  const sessionID = SessionID.descending()
  const projectID = ProjectV2.ID.make(`lifecycle-${crypto.randomUUID()}`)
  const branch = `opencode/lifecycle-${crypto.randomUUID().slice(0, 8)}`
  const directory = path.join(path.dirname(root.path), `opencode-lifecycle-${crypto.randomUUID()}`)
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
