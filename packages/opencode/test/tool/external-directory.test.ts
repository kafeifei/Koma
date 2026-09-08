import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Filesystem } from "@/util/filesystem"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

const isolateStorageRoot = Effect.fnUntraced(function* (root?: string) {
  const previous = process.env.OPENCODE_HOME
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      if (root === undefined) delete process.env.OPENCODE_HOME
      else process.env.OPENCODE_HOME = root
    }),
    () =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_HOME
        else process.env.OPENCODE_HOME = previous
      }),
  )
})

describe("tool.assertExternalDirectory", () => {
  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("no-ops for paths inside the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "file.txt"))

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside", "file.txt")
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* assertExternalDirectoryEffect(ctx, target)

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.instance("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside")
      const expected = glob(path.join(target, "*"))

      yield* assertExternalDirectoryEffect(ctx, target, { kind: "directory" })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("skips prompting when bypass=true", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

      expect(requests.length).toBe(0)
    }),
  )

  it.instance(
    "accepts old and physical paths for the same worktree, including missing files",
    () =>
      Effect.gen(function* () {
        const ins = yield* InstanceState.context
        const outer = yield* tmpdirScoped()
        yield* isolateStorageRoot(outer)
        const logical = path.join(outer, "legacy-worktree")
        yield* Effect.promise(async () => {
          await fs.symlink(ins.directory, logical)
          await Bun.write(path.join(ins.directory, "file.txt"), "same file")
        })
        const input = makeCtx()
        for (const directory of [logical, ins.directory]) {
          for (const suffix of ["file.txt", "new/nested/file.txt"]) {
            expect(
              yield* assertExternalDirectoryEffect(input.ctx, path.join(directory, suffix)).pipe(
                Effect.provideService(InstanceRef, { ...ins, directory: logical, worktree: logical }),
              ),
            ).toBe(false)
          }
        }
        expect(input.requests).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "asks for the actual external target when either alias traverses an escaping symlink",
    () =>
      Effect.gen(function* () {
        const ins = yield* InstanceState.context
        const outer = yield* tmpdirScoped()
        yield* isolateStorageRoot(outer)
        const logical = path.join(outer, "legacy-worktree")
        const outside = path.join(outer, "outside")
        yield* Effect.promise(async () => {
          await fs.mkdir(outside)
          await fs.symlink(ins.directory, logical)
          await fs.symlink(outside, path.join(ins.directory, "escape"))
          await Bun.write(path.join(outside, "file.txt"), "external file")
        })
        const input = makeCtx()
        for (const directory of [logical, ins.directory]) {
          for (const suffix of ["file.txt", "missing.txt"]) {
            expect(
              yield* assertExternalDirectoryEffect(input.ctx, path.join(directory, "escape", suffix)).pipe(
                Effect.provideService(InstanceRef, { ...ins, directory: logical, worktree: logical }),
              ),
            ).toBe(true)
          }
        }
        expect(input.requests).toHaveLength(4)
        expect(input.requests.every((request) => request.patterns[0] === glob(path.join(outside, "*")))).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "does not infer internal access through a dangling or cyclic symlink",
    () =>
      Effect.gen(function* () {
        const ins = yield* InstanceState.context
        const outer = yield* tmpdirScoped()
        yield* isolateStorageRoot(outer)
        const dangling = path.join(ins.directory, "dangling")
        const cyclic = path.join(ins.directory, "cyclic")
        yield* Effect.promise(async () => {
          await fs.symlink(path.join(outer, "not-created"), dangling)
          await fs.symlink(cyclic, cyclic)
        })
        const input = makeCtx()
        expect(yield* assertExternalDirectoryEffect(input.ctx, dangling)).toBe(true)
        expect(yield* assertExternalDirectoryEffect(input.ctx, cyclic)).toBe(true)
        expect(input.requests).toHaveLength(2)
      }),
    { git: true },
  )

  it.instance(
    "keeps the original lexical permission behavior without a unified home",
    () =>
      Effect.gen(function* () {
        yield* isolateStorageRoot()
        const ins = yield* InstanceState.context
        const outer = yield* tmpdirScoped()
        const logical = path.join(outer, "legacy-worktree")
        yield* Effect.promise(async () => {
          await fs.symlink(ins.directory, logical)
          await fs.symlink(outer, path.join(ins.directory, "escape"))
          await Bun.write(path.join(ins.directory, "file.txt"), "internal")
          await Bun.write(path.join(outer, "outside.txt"), "external")
        })
        const input = makeCtx()
        const context = { ...ins, directory: logical, worktree: logical }
        expect(
          yield* assertExternalDirectoryEffect(input.ctx, path.join(ins.directory, "file.txt")).pipe(
            Effect.provideService(InstanceRef, context),
          ),
        ).toBe(true)
        expect(
          yield* assertExternalDirectoryEffect(input.ctx, path.join(logical, "escape", "outside.txt")).pipe(
            Effect.provideService(InstanceRef, context),
          ),
        ).toBe(false)
        expect(input.requests).toHaveLength(1)
        expect(input.requests[0]?.patterns).toEqual([glob(path.join(ins.directory, "*"))])
      }),
    { git: true },
  )

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const alt = target
            .replace(/^[A-Za-z]:/, "")
            .replaceAll("\\", "/")
            .toLowerCase()

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )
  }
})
