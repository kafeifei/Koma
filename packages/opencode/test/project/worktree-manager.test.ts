import { createHash } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import fs from "fs/promises"
import path from "path"
import { Git } from "../../src/git"
import { InstanceDisposal } from "../../src/project/instance-disposal"
import { SessionID } from "../../src/session/schema"
import { Storage } from "../../src/storage/storage"
import { WorktreeArchive } from "../../src/worktree/archive"
import { WorktreeLifecycle } from "../../src/worktree/lifecycle"
import { WorktreeManager } from "../../src/worktree/manager"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      WorktreeManager.node,
      WorktreeLifecycle.node,
      WorktreeArchive.node,
      InstanceDisposal.node,
      Storage.node,
      Database.node,
      Git.node,
    ]),
  ),
)

const scopedTmpdir = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir({ git: true })),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const git = Effect.fn("WorktreeManagerTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* (yield* Git.Service).run(args, { cwd })
  if (result.exitCode !== 0) {
    return yield* Effect.fail(new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`))
  }
  return result.text().trim()
})

const fixture = Effect.fn("WorktreeManagerTest.fixture")(function* () {
  const root = yield* scopedTmpdir()
  yield* Effect.promise(() => Bun.write(path.join(root.path, ".gitignore"), "ignored-link\n.env\n"))
  yield* Effect.promise(() => Bun.write(path.join(root.path, "tracked.txt"), "base\n"))
  yield* git(root.path, ["add", ".gitignore", "tracked.txt"])
  yield* git(root.path, ["commit", "--no-gpg-sign", "-m", "manager base"])
  const directory = path.join(path.dirname(root.path), `opencode-manager-${crypto.randomUUID()}`)
  const branch = `manager-${crypto.randomUUID().slice(0, 8)}`
  yield* git(root.path, ["worktree", "add", "-b", branch, directory, "HEAD"])
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* git(root.path, ["worktree", "remove", "--force", directory]).pipe(Effect.ignore)
      yield* Effect.promise(() => fs.rm(directory, { recursive: true, force: true }))
    }),
  )

  const projectID = ProjectV2.ID.make(`manager-${crypto.randomUUID()}`)
  const { db } = yield* Database.Service
  const storage = yield* Storage.Service
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
  yield* Effect.addFinalizer(() =>
    db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run().pipe(Effect.orDie),
  )

  const insertSession = Effect.fnUntraced(function* (target = directory) {
    const id = SessionID.descending()
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: projectID,
        slug: id,
        directory: target,
        title: `session ${id}`,
        version: "0.0.0-test",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
    return id
  })

  const clearLifecycle = (target: string) =>
    storage.remove(["worktree_lifecycle", createHash("sha256").update(target).digest("hex")]).pipe(Effect.ignore)
  yield* Effect.addFinalizer(() => clearLifecycle(directory))
  return { branch, db, directory, insertSession, manager: yield* WorktreeManager.Service, projectID, root: root.path }
})

describe("WorktreeManager", () => {
  it.live("lists an orphan, previews details, and adopts its unique root session without taking branch ownership", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const sessionID = yield* input.insertSession()
      yield* Effect.promise(() => Bun.write(path.join(input.directory, ".env"), "TOKEN=local\n"))
      if (process.platform !== "win32") {
        yield* Effect.promise(() => fs.symlink("tracked.txt", path.join(input.directory, "ignored-link")))
      }

      const before = yield* input.manager.list({ root: input.root, projectID: input.projectID })
      expect(before.find((entry) => entry.directory === input.root)?.primary).toBe(true)
      expect(before.find((entry) => entry.directory === input.directory)).toMatchObject({
        branch: input.branch,
        registered: true,
        managed: false,
        orphan: false,
        shared: false,
        sessions: [{ id: sessionID, archived: false }],
      })

      const details = yield* input.manager.details({
        root: input.root,
        projectID: input.projectID,
        directory: input.directory,
      })
      expect(details.ignored?.preserved.map((entry) => entry.path)).toContain(".env")
      if (process.platform !== "win32") expect(details.space?.symlinks).toBe(1)

      const adopted = yield* input.manager.adopt({
        root: input.root,
        projectID: input.projectID,
        directory: input.directory,
        sessionID,
      })
      expect(adopted).toMatchObject({ managed: true, owner: { sessionID, phase: "resident" } })
      expect((yield* (yield* WorktreeLifecycle.Service).get(sessionID))?.branchOwned).toBe(false)
    }),
  )

  it.live("rejects primary, detached, busy, and shared worktrees", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            input.manager.adopt({ root: input.root, projectID: input.projectID, directory: input.root }),
          ),
        ),
      ).toBe(true)

      const lifecycle = yield* WorktreeLifecycle.Service
      const busyID = SessionID.descending()
      yield* lifecycle.acquire({ directory: input.directory, sessionID: busyID })
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            input.manager.adopt({ root: input.root, projectID: input.projectID, directory: input.directory }),
          ),
        ),
      ).toBe(true)
      yield* lifecycle.release({ directory: input.directory, sessionID: busyID })

      yield* input.insertSession()
      yield* input.insertSession()
      const shared = (yield* input.manager.list({ root: input.root, projectID: input.projectID })).find(
        (entry) => entry.directory === input.directory,
      )
      expect(shared?.shared).toBe(true)
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            input.manager.adopt({ root: input.root, projectID: input.projectID, directory: input.directory }),
          ),
        ),
      ).toBe(true)

      const detached = path.join(path.dirname(input.root), `opencode-manager-detached-${crypto.randomUUID()}`)
      yield* git(input.root, ["worktree", "add", "--detach", detached, "HEAD"])
      yield* Effect.addFinalizer(() =>
        git(input.root, ["worktree", "remove", "--force", detached]).pipe(
          Effect.ignore,
          Effect.andThen(Effect.promise(() => fs.rm(detached, { recursive: true, force: true }))),
        ),
      )
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            input.manager.adopt({ root: input.root, projectID: input.projectID, directory: detached }),
          ),
        ),
      ).toBe(true)
    }),
  )

  it.live("reports lifecycle records missing from Git and rejects unrelated directories", () =>
    Effect.gen(function* () {
      const input = yield* fixture()
      const missing = path.join(path.dirname(input.root), `opencode-manager-missing-${crypto.randomUUID()}`)
      const lifecycle = yield* WorktreeLifecycle.Service
      yield* git(input.root, ["worktree", "add", "-b", "missing-branch", missing, "HEAD"])
      yield* Effect.addFinalizer(() =>
        git(input.root, ["worktree", "remove", "--force", missing]).pipe(
          Effect.ignore,
          Effect.andThen(Effect.promise(() => fs.rm(missing, { recursive: true, force: true }))),
        ),
      )
      yield* lifecycle.register({
        directory: missing,
        root: input.root,
        branch: "missing-branch",
        branchOwned: false,
        projectID: input.projectID,
      })
      yield* git(input.root, ["worktree", "remove", missing])
      const storage = yield* Storage.Service
      yield* Effect.addFinalizer(() =>
        storage.remove(["worktree_lifecycle", createHash("sha256").update(missing).digest("hex")]).pipe(Effect.ignore),
      )

      const entry = (yield* input.manager.list({ root: input.root, projectID: input.projectID })).find(
        (item) => item.directory === missing,
      )
      expect(entry).toMatchObject({ registered: false, managed: true, missing: true })
      expect(
        (yield* input.manager.details({ root: input.root, projectID: input.projectID, directory: missing })).space,
      ).toBeUndefined()

      const unrelated = yield* scopedTmpdir()
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            input.manager.details({ root: input.root, projectID: input.projectID, directory: unrelated.path }),
          ),
        ),
      ).toBe(true)
    }),
  )
})
