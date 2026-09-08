import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Layer, Ref } from "effect"
import { Fiber } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceState } from "@/effect/instance-state"
import { SessionRunState } from "@/session/run-state"
import { WorktreeLifecycle } from "@/worktree/lifecycle"
import { WorktreeArchive } from "@/worktree/archive"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"

const exists = (target: string) =>
  Effect.promise(() =>
    fs
      .stat(target)
      .then(() => true)
      .catch(() => false),
  )

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      SessionRunState.node,
      WorktreeLifecycle.node,
      WorktreeArchive.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live(
    "keeps a managed session archived when restore ref cleanup fails and retries after unlock",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() => Bun.write(path.join(root, "tracked.txt"), "base\n"))
        yield* Effect.promise(() => $`git add tracked.txt && git commit -m ${"restore failure base"}`.cwd(root).quiet())
        const branch = `opencode/restore-${crypto.randomUUID().slice(0, 8)}`
        const directory = path.join(path.dirname(root), `opencode-restore-${crypto.randomUUID()}`)
        yield* Effect.promise(() => $`git worktree add -b ${branch} ${directory} HEAD`.cwd(root).quiet())
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await $`git worktree remove --force ${directory}`.cwd(root).quiet().nothrow()
            await fs.rm(directory, { recursive: true, force: true })
          }),
        )

        const session = yield* SessionNs.Service
        const lifecycle = yield* WorktreeLifecycle.Service
        const created = yield* provideInstance(directory)(
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            if (!ctx.project.id) return yield* Effect.die("managed lifecycle test requires a project ID")
            yield* lifecycle.register({ directory, root, branch, projectID: ctx.project.id })
            const info = yield* session.create({ title: "restore cleanup failure" })
            yield* Effect.promise(() => Bun.write(path.join(directory, "tracked.txt"), "working\n"))
            yield* session.setArchived({ sessionID: info.id, time: Date.now() })
            return info
          }),
        )
        expect(yield* exists(directory)).toBe(false)

        const lock = path.join(root, ".git", "refs", "opencode", "worktree-archive", `${created.id}.lock`)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(lock), { recursive: true })
          await Bun.write(lock, "locked")
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(lock, { force: true })))

        const failed = yield* provideInstance(root)(session.setArchived({ sessionID: created.id })).pipe(Effect.flip)
        expect(failed.reason).toBe("git")
        expect((yield* session.get(created.id)).time.archived).toBeNumber()
        expect(yield* lifecycle.get(created.id)).toMatchObject({ intent: "restore", phase: "restored" })
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "tracked.txt")).text())).toBe("working\n")

        yield* Effect.promise(() => fs.rm(lock, { force: true }))
        yield* provideInstance(root)(session.setArchived({ sessionID: created.id }))
        expect((yield* session.get(created.id)).time.archived).toBeUndefined()
        expect(yield* lifecycle.get(created.id)).toMatchObject({ phase: "resident" })
      }),
    { timeout: 30000 },
  )

  it.live(
    "finishes a pending archive after the active runner becomes idle and restores through the project root",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() => Bun.write(path.join(root, "tracked.txt"), "base\n"))
        yield* Effect.promise(() =>
          $`git add tracked.txt && git commit -m ${"session lifecycle base"}`.cwd(root).quiet(),
        )
        const branch = `opencode/session-${crypto.randomUUID().slice(0, 8)}`
        const directory = path.join(path.dirname(root), `opencode-session-${crypto.randomUUID()}`)
        yield* Effect.promise(() => $`git worktree add -b ${branch} ${directory} HEAD`.cwd(root).quiet())
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await $`git worktree remove --force ${directory}`.cwd(root).quiet().nothrow()
            await fs.rm(directory, { recursive: true, force: true })
          }),
        )

        const session = yield* SessionNs.Service
        const lifecycle = yield* WorktreeLifecycle.Service
        const created = yield* provideInstance(directory)(
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            if (!ctx.project.id) return yield* Effect.die("managed lifecycle test requires a project ID")
            yield* lifecycle.register({
              directory,
              root,
              branch,
              projectID: ctx.project.id,
            })
            const info = yield* session.create({ title: "managed lifecycle" })
            yield* Effect.promise(() => Bun.write(path.join(directory, "tracked.txt"), "working\n"))

            const runState = yield* SessionRunState.Service
            const started = yield* Deferred.make<void>()
            const finish = yield* Deferred.make<void>()
            const runs = yield* Ref.make(0)
            const answer = { info: { sessionID: info.id }, parts: [] } as unknown as SessionV1.WithParts
            const work = Ref.update(runs, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(finish)),
              Effect.as(answer),
            )
            const fibers = yield* Effect.all(
              [
                runState.ensureRunning(info.id, Effect.succeed(answer), work),
                runState.ensureRunning(info.id, Effect.succeed(answer), work),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.forkChild)
            yield* Deferred.await(started)
            expect(yield* Ref.get(runs)).toBe(1)

            yield* session.setArchived({ sessionID: info.id, time: Date.now() })
            expect(yield* exists(directory)).toBe(true)
            expect(yield* lifecycle.get(info.id)).toMatchObject({ intent: "archive", phase: "resident" })

            yield* Deferred.succeed(finish, undefined)
            yield* Fiber.join(fibers)
            yield* pollWithTimeout(
              lifecycle.get(info.id).pipe(Effect.map((owner) => (owner?.phase === "removed" ? owner : undefined))),
              "runner idle did not release the managed checkout for archive",
            )
            return info
          }),
        )

        expect(yield* exists(directory)).toBe(false)
        const archived = yield* lifecycle.get(created.id)
        expect(archived?.root).toBe(root)
        if (!archived?.oid) return yield* Effect.die("managed lifecycle test requires an archive oid")
        expect(yield* session.routingDirectory(created.id)).toBe(root)
        expect(
          yield* Effect.promise(() =>
            $`git rev-parse --verify refs/opencode/worktree-archive/${created.id}`.cwd(root).quiet().nothrow(),
          ).pipe(Effect.map((result) => result.text().trim())),
        ).toBe(archived?.oid)
        yield* lifecycle.prepareRestore(created.id)
        yield* (yield* WorktreeArchive.Service).clear({
          directory: root,
          sessionID: created.id,
          oid: archived.oid,
        })
        expect(yield* lifecycle.get(created.id)).toMatchObject({ intent: "restore", phase: "restored" })
        yield* provideInstance(root)(session.setArchived({ sessionID: created.id }))
        expect(yield* session.routingDirectory(created.id)).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "tracked.txt")).text())).toBe("working\n")
        expect(yield* lifecycle.get(created.id)).toMatchObject({ phase: "resident" })

        const events = yield* EventV2Bridge.Service
        const stop = yield* events.listen((event) => {
          if (event.type !== SessionNs.Event.Deleted.type) return Effect.void
          const data = event.data as typeof SessionNs.Event.Deleted.data.Type
          if (data.sessionID !== created.id) return Effect.void
          return Effect.promise(() => $`git branch -m lifecycle-retry-blocker`.cwd(directory).quiet())
        })
        const firstRemove = yield* provideInstance(root)(session.remove(created.id)).pipe(Effect.exit)
        yield* stop
        expect(Exit.isFailure(firstRemove)).toBe(true)
        expect(yield* lifecycle.get(created.id)).toMatchObject({ intent: "delete" })
        yield* Effect.promise(() => $`git branch -m ${branch}`.cwd(directory).quiet())
        yield* provideInstance(root)(session.remove(created.id))
        expect(yield* lifecycle.get(created.id)).toBeUndefined()
        expect(yield* exists(directory)).toBe(false)
      }),
    { timeout: 30000 },
  )

  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("forks the chronological prefix across mixed message ID ordering", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const ids = ["msg_z9-before", "msg_z1-before-wrap", "msg_a0-after-wrap", "msg_a1-after"]
      for (const [index, id] of ids.entries()) {
        yield* session.updateMessage({
          id: MessageID.make(id),
          sessionID: created.id,
          role: "user",
          time: { created: index + 1 },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
      }

      const beforeWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[1]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      const afterWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[2]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      expect((yield* session.messages({ sessionID: beforeWrap.id })).map((msg) => msg.info.time.created)).toEqual([1])
      expect((yield* session.messages({ sessionID: afterWrap.id })).map((msg) => msg.info.time.created)).toEqual([1, 2])
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})
