import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ProjectDirectories.node])))

const projectID = Project.ID.make("project-directories")
const directory = AbsolutePath.make("/tmp/project-directories")

function setup() {
  return Database.Service.use(({ db }) =>
    db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: directory, sandboxes: [], time_created: 1, time_updated: 1 })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )
}

const migrated = Effect.fnUntraced(function* () {
  yield* setup()
  const temp = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  )
  const root = path.join(temp.path, "storage")
  const physical = AbsolutePath.make(path.join(root, "worktrees", "project", "old"))
  const logical = AbsolutePath.make(path.join(temp.path, "legacy", "old"))
  yield* Effect.promise(async () => {
    await fs.mkdir(physical, { recursive: true })
    await fs.mkdir(path.dirname(logical))
    await fs.symlink(physical, logical)
    await Bun.write(
      path.join(root, "storage.json"),
      JSON.stringify({
        version: 1,
        source: path.dirname(logical),
        status: "complete",
        database: "opencode.db",
        worktrees: [{ directory: logical, path: physical }],
      }),
    )
  })
  const previous = process.env.OPENCODE_HOME
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.env.OPENCODE_HOME = root
    }),
    () =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_HOME
        else process.env.OPENCODE_HOME = previous
      }),
  )
  return { physical, logical, db: (yield* Database.Service).db, service: yield* ProjectDirectories.Service }
})

const stored = () =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(ProjectDirectoryTable)
      .where(eq(ProjectDirectoryTable.project_id, projectID))
      .all()
      .pipe(Effect.orDie),
  )

describe("ProjectDirectories", () => {
  it.effect("decodes directory schemas", () =>
    Effect.sync(() => {
      expect(Schema.decodeUnknownSync(ProjectDirectories.ListInput)({ projectID })).toEqual({ projectID })
      expect(Schema.decodeUnknownSync(ProjectDirectories.ListOutput)([{ directory }])).toEqual([{ directory }])
    }),
  )

  it.effect("creates once and ignores conflicts", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service

      expect(yield* service.create({ projectID, directory })).toBe(true)
      expect(yield* service.create({ projectID, directory, strategy: "git_worktree" })).toBe(false)
      expect(yield* service.list(projectID)).toEqual([{ directory, strategy: undefined }])
    }),
  )

  it.effect("replaces the strategy when requested", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service
      yield* service.create({ projectID, directory, strategy: "old/strategy" })

      expect(yield* service.create({ projectID, directory, strategy: "new/strategy", behavior: "replace" })).toBe(true)
      expect(yield* service.create({ projectID, directory, strategy: "new/strategy", behavior: "replace" })).toBe(false)
      expect(yield* service.create({ projectID, directory, behavior: "replace" })).toBe(true)
      expect(yield* service.create({ projectID, directory, behavior: "replace" })).toBe(false)
      expect(yield* service.create({ projectID, directory, strategy: "new/strategy", behavior: "replace" })).toBe(true)
      expect(yield* service.list(projectID)).toEqual([{ directory, strategy: "new/strategy" }])
    }),
  )

  it.live("adopts a physical-only migrated registration without losing its metadata", () =>
    Effect.gen(function* () {
      const input = yield* migrated()
      yield* input.db
        .insert(ProjectDirectoryTable)
        .values({
          project_id: projectID,
          directory: input.physical,
          strategy: "git_worktree",
          type: "git_worktree",
          time_created: 12,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* input.service.contains({ projectID, directory: input.logical })).toBe(true)
      expect(yield* input.service.get({ projectID, directory: input.physical })).toEqual({
        directory: input.logical,
        strategy: "git_worktree",
      })
      expect(yield* input.service.list(projectID)).toEqual([{ directory: input.logical, strategy: "git_worktree" }])
      expect(yield* stored()).toEqual([
        {
          project_id: projectID,
          directory: input.logical,
          strategy: "git_worktree",
          type: "git_worktree",
          time_created: 12,
        },
      ])
      expect(yield* input.service.create({ projectID, directory: input.physical })).toBe(false)
      expect(yield* input.service.remove({ projectID, directory: input.physical })).toBe(true)
      expect(yield* stored()).toEqual([])
      expect((yield* Effect.promise(() => fs.stat(input.physical))).isDirectory()).toBe(true)
    }),
  )

  it.live("coalesces existing aliases in one project and retains ownership fields", () =>
    Effect.gen(function* () {
      const input = yield* migrated()
      yield* input.db
        .insert(ProjectDirectoryTable)
        .values([
          { project_id: projectID, directory: input.logical, time_created: 10 },
          {
            project_id: projectID,
            directory: input.physical,
            strategy: "git_worktree",
            type: "git_worktree",
            time_created: 20,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      const other = Project.ID.make("unrelated-project")
      yield* input.db
        .insert(ProjectTable)
        .values({ id: other, worktree: input.physical, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* input.db
        .insert(ProjectDirectoryTable)
        .values({ project_id: other, directory: input.physical })
        .run()
        .pipe(Effect.orDie)

      expect(yield* input.service.list(projectID)).toEqual([{ directory: input.logical, strategy: "git_worktree" }])
      expect(yield* input.service.list(projectID)).toEqual([{ directory: input.logical, strategy: "git_worktree" }])
      expect(yield* stored()).toEqual([
        {
          project_id: projectID,
          directory: input.logical,
          strategy: "git_worktree",
          type: "git_worktree",
          time_created: 10,
        },
      ])
      expect(
        (yield* input.db
          .select()
          .from(ProjectDirectoryTable)
          .where(eq(ProjectDirectoryTable.project_id, other))
          .all()
          .pipe(Effect.orDie))[0]?.directory,
      ).toBe(input.physical)
    }),
  )

  it.live("preserves conflicting strategy records instead of silently choosing ownership", () =>
    Effect.gen(function* () {
      const input = yield* migrated()
      yield* input.db
        .insert(ProjectDirectoryTable)
        .values([
          { project_id: projectID, directory: input.logical, strategy: "git_worktree", time_created: 10 },
          { project_id: projectID, directory: input.physical, strategy: "other/owner", time_created: 20 },
        ])
        .run()
        .pipe(Effect.orDie)
      const before = yield* stored()
      expect((yield* input.service.list(projectID)).length).toBe(2)
      expect(yield* stored()).toEqual(before)
    }),
  )

  it.live("uses the caller transaction so rollback also restores alias registrations", () =>
    Effect.gen(function* () {
      const input = yield* migrated()
      yield* input.db
        .insert(ProjectDirectoryTable)
        .values({ project_id: projectID, directory: input.physical, time_created: 7 })
        .run()
        .pipe(Effect.orDie)
      yield* input.db
        .transaction((tx) =>
          Effect.gen(function* () {
            expect(yield* input.service.create({ projectID, directory: input.logical }, tx)).toBe(true)
            return yield* Effect.fail("rollback")
          }),
        )
        .pipe(Effect.exit)
      expect((yield* stored()).map((row) => row.directory)).toEqual([input.physical])
    }),
  )
})
