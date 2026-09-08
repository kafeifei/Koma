import { $ } from "bun"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { ProjectDirectoryTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { eq } from "drizzle-orm"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { Worktree } from "../../src/worktree"
import { WorktreeLifecycle } from "../../src/worktree/lifecycle"
import { WorktreeManager } from "../../src/worktree/manager"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      InstanceStore.node,
      Worktree.node,
      WorktreeLifecycle.node,
      WorktreeManager.node,
      CrossSpawnSpawner.node,
      Database.node,
      ProjectDirectories.node,
      ProjectCopy.node,
    ]),
    [
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

it.live("moving a managed worktree keeps its instance, project list and lifecycle identity", () =>
  Effect.gen(function* () {
    const primary = yield* tmpdirScoped({ git: true })
    const temp = yield* tmpdirScoped()
    const old = path.join(temp, "legacy", "old")
    const root = path.join(temp, "storage")
    const physical = path.join(root, "worktrees", "project", "old")
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(old), { recursive: true })
      await fs.mkdir(path.dirname(physical), { recursive: true })
      await $`git worktree add -b retained-identity ${old}`.cwd(primary).quiet()
    })
    const instances = yield* InstanceStore.Service
    const lifecycle = yield* WorktreeLifecycle.Service
    const worktrees = yield* Worktree.Service
    const manager = yield* WorktreeManager.Service
    const directories = yield* ProjectDirectories.Service
    const copies = yield* ProjectCopy.Service
    const db = (yield* Database.Service).db
    yield* instances.load({ directory: primary })
    const before = yield* instances.load({ directory: old })
    yield* lifecycle.register({
      directory: old,
      root: primary,
      branch: "retained-identity",
      projectID: before.project.id,
    })
    yield* instances.dispose(before)
    yield* Effect.promise(async () => {
      await fs.rename(old, physical)
      await fs.symlink(physical, old)
      await Bun.write(
        path.join(root, "storage.json"),
        JSON.stringify({
          version: 1,
          source: path.join(temp, "legacy"),
          status: "complete",
          database: "opencode.db",
          worktrees: [{ directory: old, path: physical }],
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
    // Model the physical duplicate written by versions that registered raw realpaths.
    yield* db
      .insert(ProjectDirectoryTable)
      .values({
        project_id: before.project.id,
        directory: AbsolutePath.make(physical),
      })
      .run()
      .pipe(Effect.orDie)
    const opened = yield* instances.load({ directory: physical })
    expect(opened.directory).toBe(old)
    expect(opened.project.id).toBe(before.project.id)
    expect(opened.project.sandboxes).toContain(old)
    const registered = yield* db
      .select()
      .from(ProjectDirectoryTable)
      .where(eq(ProjectDirectoryTable.project_id, before.project.id))
      .all()
      .pipe(Effect.orDie)
    expect(
      registered.filter((row) => row.directory === old || row.directory === physical).map((row) => row.directory),
    ).toEqual([AbsolutePath.make(old)])
    expect(yield* directories.get({ projectID: before.project.id, directory: AbsolutePath.make(physical) })).toEqual({
      directory: AbsolutePath.make(old),
      strategy: undefined,
    })
    const copied = yield* copies.create({
      projectID: before.project.id,
      sourceDirectory: AbsolutePath.make(physical),
      strategy: ProjectCopy.StrategyID.make("git_worktree"),
      directory: AbsolutePath.make(path.join(temp, "copies")),
      name: "alias-source",
    })
    expect((yield* Effect.promise(() => fs.stat(copied.directory))).isDirectory()).toBe(true)
    yield* copies.remove({ projectID: before.project.id, directory: copied.directory, force: false })
    expect(yield* instances.load({ directory: old })).toBe(opened)
    expect(
      (yield* instances.provide({ directory: primary }, worktrees.list())).map((item) => item.directory),
    ).toContain(old)
    expect((yield* lifecycle.getDirectory(physical))?.directory).toBe(old)
    expect(yield* lifecycle.leaseDirectory(physical)).toBe(old)
    expect(
      (yield* manager.list({ root: primary, projectID: before.project.id })).find((item) => item.directory === old)
        ?.managed,
    ).toBe(true)
    yield* instances.disposeDirectory(physical)
  }),
)
