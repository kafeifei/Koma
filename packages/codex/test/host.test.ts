import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, writeFile, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExternal } from "@opencode-ai/core/session/external/index"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { CodexHost } from "../src/host"
import { CodexWorktreeAccess } from "../src/worktree-access"
import { CodexAuth } from "../src/auth"
import { CodexProviders } from "../src/providers"
import type { v2 } from "../src/protocol/generated/index"

let directory: string
const environment = ["OPENCODE_ENABLE_CODEX", "OPENCODE_CODEX_HOME", "OPENCODE_CODEX_BINARY"]
const previous = new Map(environment.map((key) => [key, process.env[key]]))
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "codex-host-test-"))
  const binary = path.join(directory, "codex-fixture")
  await writeFile(
    binary,
    `#!${process.execPath}\nawait import(${JSON.stringify(path.join(import.meta.dir, "fixture/host-peer.ts"))})\n`,
  )
  await chmod(binary, 0o755)
  process.env.OPENCODE_ENABLE_CODEX = "1"
  process.env.OPENCODE_CODEX_BINARY = binary
})
afterAll(() =>
  environment.forEach((key) => {
    const value = previous.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }),
)

function thread(): v2.Thread {
  return {
    id: "native-thread",
    extra: null,
    sessionId: "native-session",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: "fixture",
    model: "native-model",
    reasoningEffort: "low",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: directory,
    cliVersion: "0.153.4",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  }
}

async function harness<A>(
  fn: (input: {
    host: CodexHost.Interface
    sessions: SessionExternal.Interface
    database: Database.Interface
    home: string
    scope: string
    gate: { refuse: boolean; acquired: number; released: number }
  }) => Promise<A>,
  homeOverride?: string,
  auth?: CodexAuth.Interface,
  providers?: CodexProviders.Interface,
) {
  const home = homeOverride ?? (await mkdtemp(path.join(directory, "home-")))
  await writeFile(path.join(home, "command.json"), JSON.stringify({ id: randomUUID(), messages: [] }))
  process.env.OPENCODE_CODEX_HOME = home
  await writeFile(path.join(home, "fixture.json"), JSON.stringify({ thread: thread() }))
  const gate = { refuse: false, acquired: 0, released: 0 }
  const layer = AppNodeBuilder.build(LayerNode.group([CodexHost.node, SessionExternal.node, Database.node]), [
    ...(auth ? [[CodexAuth.node, Layer.succeed(CodexAuth.Service, auth)] as const] : []),
    ...(providers ? [[CodexProviders.node, Layer.succeed(CodexProviders.Service, providers)] as const] : []),
    [Database.node, Database.layerFromPath(":memory:")],
    [Global.node, Global.layerWith({ home, state: home })],
    [
      ProjectV2.node,
      Layer.mock(ProjectV2.Service, { resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }) }),
    ],
    [
      CodexWorktreeAccess.node,
      Layer.succeed(CodexWorktreeAccess.Service, {
        claim: () => Effect.succeed(false),
        acquire: () =>
          Effect.suspend(() =>
            gate.refuse
              ? Effect.fail(new Error("Archive gate refused"))
              : Effect.sync(() => {
                  gate.acquired++
                }),
          ),
        release: () =>
          Effect.sync(() => {
            gate.released++
          }),
      }),
    ],
  ])
  return Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* CodexHost.Service
      const sessions = yield* SessionExternal.Service
      const database = yield* Database.Service
      return yield* Effect.promise(() =>
        fn({ host, sessions, database, home, scope: `codex:${createHash("sha256").update(home).digest("hex")}`, gate }),
      )
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}
const run = Effect.runPromise
const prompt = { prompt: { text: "hello" }, settings: {} }
const location = () => Location.Ref.make({ directory: AbsolutePath.make(directory) })
const rpc = async (home: string) =>
  (await readFile(path.join(home, "rpc.jsonl"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: string | number; method?: string; error?: unknown; result?: unknown })
const configure = async (home: string, patch: object) => {
  const file = path.join(home, "fixture.json")
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), ...patch }))
}
const command = (home: string, messages: unknown[]) =>
  writeFile(path.join(home, "command.json"), JSON.stringify({ id: randomUUID(), messages }))
async function until<A>(read: () => Promise<A>, check: (value: A) => boolean): Promise<A> {
  const deadline = Date.now() + 5_000
  while (true) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`)
    await Bun.sleep(10)
  }
}

async function seed(sessions: SessionExternal.Interface, scope: string, target = location()) {
  const created = await run(
    sessions.create({
      runtimeScope: scope,
      requestID: "seed",
      engine: "codex",
      location: target,
      payload: prompt,
      delivery: "steer",
    }),
  )
  await run(sessions.claimBinding({ sessionID: created.session.id, generation: "seed" }))
  await run(sessions.bind({ sessionID: created.session.id, nativeThreadID: "native-thread", generation: "seed" }))
  await run(sessions.withdraw({ sessionID: created.session.id, requestID: "seed" }))
  return created.session.id
}

function workspacePolicy(
  writableRoots = [directory],
): Pick<v2.ThreadStartResponse, "sandbox" | "approvalPolicy" | "approvalsReviewer"> {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite",
      writableRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  }
}

function approval(id: string, kind: "command" | "file" | "permissions" = "command") {
  return {
    id,
    method:
      kind === "command"
        ? "item/commandExecution/requestApproval"
        : kind === "file"
          ? "item/fileChange/requestApproval"
          : "item/permissions/requestApproval",
    params: {
      threadId: "native-thread",
      turnId: "turn-1",
      itemId: id,
      ...(kind === "command" ? { availableDecisions: ["acceptForSession", "accept", "decline"] } : {}),
      ...(kind === "permissions" ? { permissions: { network: { enabled: true } } } : {}),
    },
  }
}

const customProviders: CodexProviders.Interface = {
  list: async () => [
    {
      id: "xd",
      name: "XD",
      baseURL: "https://example.invalid/v1",
      models: [{ id: "native-model", name: "Custom", efforts: ["low", "high"] }],
    },
  ],
  key: async () => "fixture-only-key",
  onChange: () => () => {},
}

async function complete(home: string) {
  const config = JSON.parse(await readFile(path.join(home, "fixture.json"), "utf8")) as { thread: v2.Thread }
  const turn = config.thread.turns.at(-1)!
  turn.status = "completed"
  turn.completedAt = Date.now()
  config.thread.status = { type: "idle" }
  await configure(home, config)
  await command(home, [{ method: "turn/completed", params: { threadId: config.thread.id, turn } }])
}

describe("CodexHost native process boundaries", () => {
  test(
    "custom models work without ChatGPT and switch providers only after idle, preserving restoration",
    () =>
      harness(
        async ({ host, home, sessions }) => {
          await configure(home, { authenticated: false, reflectProvider: true, reflectSettings: true })
          const engine = await run(host.engines()).then((engines) => engines.find((engine) => engine.id === "codex")!)
          expect(engine.models?.find((model) => model.id === "xd/native-model")?.requiresAuth).toBe(false)
          await expect(
            run(
              host.create({
                requestID: "needs-login",
                engine: "codex",
                location: location(),
                input: prompt,
                delivery: "steer",
              }),
            ),
          ).rejects.toThrow("Sign in")
          const created = await run(
            host.create({
              requestID: "xd-first",
              engine: "codex",
              location: location(),
              input: { ...prompt, settings: { model: "xd/native-model" } },
              delivery: "steer",
            }),
          )
          const id = created.descriptor.sessionID
          await until(
            () => run(host.delivery(id, "xd-first")),
            (value) => value.state === "accepted",
          )
          expect((await run(host.snapshot(id))).descriptor.settings.model).toBe("xd/native-model")
          await configure(home, { authenticated: true })
          await run(
            host.submit(id, {
              requestID: "subscription-next",
              input: { ...prompt, settings: {} },
              delivery: "steer",
            }),
          )
          await Bun.sleep(100)
          expect((await run(host.delivery(id, "subscription-next"))).state).toBe("pending")
          expect((await rpc(home)).filter((call) => call.method === "turn/steer")).toHaveLength(0)
          await complete(home)
          await until(
            () => run(host.delivery(id, "subscription-next")),
            (value) => value.state === "accepted",
          )
          expect((await run(host.snapshot(id))).descriptor.settings.model).toBe("native-model")
          await complete(home)
          await until(
            () => run(host.snapshot(id)),
            (value) => value.descriptor.runtimeStatus === "idle",
          )
          // An unsent selection must not be applied by a reconnect.
          await run(host.settings(id, { model: "xd/native-model" }))
          await writeFile(path.join(home, "command.json"), JSON.stringify({ id: randomUUID(), exit: true }))
          await until(
            () => run(host.describe([id])),
            (value) => value[0]?.runtimeStatus === "disconnected",
          )
          await command(home, [])
          const restored = await run(host.snapshot(id))
          expect(restored.descriptor.settings.model).toBe("native-model")
          expect(restored.descriptor.pendingSettings?.model).toBe("xd/native-model")
          expect((await run(sessions.get(id))).binding.nativeThreadID).toBe("native-thread")
          await run(
            host.submit(id, {
              requestID: "xd-again",
              input: { ...prompt, settings: { model: "xd/native-model" } },
              delivery: "steer",
            }),
          )
          await until(
            () => run(host.delivery(id, "xd-again")),
            (value) => value.state === "accepted",
          )
          expect((await run(host.snapshot(id))).descriptor.settings.model).toBe("xd/native-model")
          const calls = await rpc(home)
          expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1)
          expect(calls.filter((call) => call.method === "thread/unsubscribe")).toHaveLength(2)
          expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(3)
          await complete(home)
          await until(
            () => run(host.snapshot(id)),
            (value) => value.descriptor.runtimeStatus === "idle",
          )
          await run(host.settings(id, { model: "native-model" }))
          await writeFile(path.join(home, "command.json"), JSON.stringify({ id: randomUUID(), exit: true }))
          await until(
            () => run(host.describe([id])),
            (value) => value[0]?.runtimeStatus === "disconnected",
          )
          await command(home, [])
          const customRestored = await run(host.snapshot(id))
          expect(customRestored.descriptor.settings.model).toBe("xd/native-model")
          expect(customRestored.descriptor.pendingSettings?.model).toBe("native-model")
        },
        undefined,
        undefined,
        customProviders,
      ),
    30_000,
  )

  test("auto approves the three native approval kinds before turn/start replies", () =>
    harness(async ({ host, home }) => {
      await configure(home, {
        reflectSettings: true,
        waitForApprovals: true,
        turnRequests: [approval("command"), approval("file", "file"), approval("permissions", "permissions")],
      })
      const created = await run(
        host.create({
          requestID: "auto-first",
          engine: "codex",
          location: location(),
          input: { ...prompt, settings: { permission: "auto" } },
          delivery: "steer",
        }),
      )
      const id = created.descriptor.sessionID
      await until(
        () => run(host.delivery(id, "auto-first")),
        (receipt) => receipt.state === "accepted",
      )
      const calls = await rpc(home)
      expect(calls.find((call) => call.id === "command")?.result).toEqual({ decision: "accept" })
      expect(calls.find((call) => call.id === "file")?.result).toEqual({ decision: "accept" })
      expect(calls.find((call) => call.id === "permissions")?.result).toEqual({
        permissions: { network: { enabled: true } },
        scope: "turn",
      })
      const snapshot = await run(host.snapshot(id))
      expect(snapshot.descriptor.settings.permission).toBe("auto")
      expect(snapshot.descriptor.pendingSettings).toBeUndefined()
    }))

  test("native workspace confirmation enables auto before a readOnly turn/start reply", () =>
    harness(async ({ host, home, sessions, scope }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      const pending = await run(host.settings(id, { permission: "auto" }))
      expect(pending.settings.permission).toBe("readOnly")
      expect(pending.pendingSettings?.permission).toBe("auto")
      await configure(home, { reflectSettings: true, waitForApprovals: true, turnRequests: [approval("changed")] })
      await run(
        host.submit(id, {
          requestID: "change",
          input: { ...prompt, settings: { permission: "auto" } },
          delivery: "steer",
        }),
      )
      await until(
        () => run(host.delivery(id, "change")),
        (receipt) => receipt.state === "accepted",
      )
      expect((await rpc(home)).find((call) => call.id === "changed")?.result).toEqual({ decision: "accept" })
      expect((await run(host.snapshot(id))).descriptor.settings.permission).toBe("auto")
    }))

  test("switching to auto settles pending approvals, switching back and failed settings stop auto", () =>
    harness(async ({ host, home, sessions, scope }) => {
      const id = await seed(sessions, scope)
      await configure(home, { nativeSettings: workspacePolicy() })
      await run(host.snapshot(id))
      await command(home, [approval("before")])
      await until(
        () => run(host.snapshot(id)),
        (snapshot) => snapshot.interactions.length === 1,
      )
      expect((await rpc(home)).some((call) => call.id === "before")).toBe(false)
      expect((await run(host.settings(id, { permission: "auto" }))).settings.permission).toBe("auto")
      await until(
        () => rpc(home),
        (calls) => calls.some((call) => call.id === "before"),
      )
      expect((await rpc(home)).find((call) => call.id === "before")?.result).toEqual({ decision: "accept" })
      expect((await run(host.settings(id, { permission: "default" }))).settings.permission).toBe("default")
      await command(home, [approval("after", "file")])
      await until(
        () => run(host.snapshot(id)),
        (snapshot) => snapshot.interactions.some((item) => item.itemRef === "after"),
      )
      await expect(run(host.settings(id, { permission: "auto", model: "missing" }))).rejects.toThrow("unavailable")
      const waiting = await run(host.snapshot(id))
      expect((await run(sessions.get(id))).binding.settings).toEqual({ permission: "default" })
      expect(waiting.descriptor.settings.permission).toBe("default")
      expect(waiting.interactions.find((item) => item.itemRef === "after")?.state).toBe("pending")
      expect((await rpc(home)).some((call) => call.id === "after")).toBe(false)
    }))

  test("auto preserves deny-only and rule amendment choices and never answers user input", () =>
    harness(async ({ host, home, sessions, scope }) => {
      const id = await seed(sessions, scope)
      await configure(home, { nativeSettings: workspacePolicy() })
      await run(host.snapshot(id))
      await run(host.settings(id, { permission: "auto" }))
      await command(home, [
        { ...approval("deny"), params: { ...approval("deny").params, availableDecisions: ["decline", "cancel"] } },
        {
          ...approval("amend"),
          params: {
            ...approval("amend").params,
            availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git"] } }],
          },
        },
        {
          id: "question",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "native-thread",
            turnId: "turn-1",
            itemId: "question",
            questions: [
              { id: "q", header: "Question", question: "Choose", options: null, isOther: true, isSecret: false },
            ],
          },
        },
        {
          id: "form",
          method: "mcpServer/elicitation/request",
          params: { threadId: "native-thread", mode: "form", requestedSchema: { type: "object", properties: {} } },
        },
        {
          id: "url",
          method: "mcpServer/elicitation/request",
          params: { threadId: "native-thread", mode: "url", url: "https://example.invalid" },
        },
      ])
      const snapshot = await until(
        () => run(host.snapshot(id)),
        (snapshot) => snapshot.interactions.length === 5,
      )
      expect(snapshot.interactions.every((item) => item.state === "pending")).toBe(true)
      expect(
        (await rpc(home)).filter((call) => ["deny", "amend", "question", "form", "url"].includes(String(call.id))),
      ).toEqual([])
    }))

  test.each(["readOnly", "network", "reviewer", "extraRoots"] as const)(
    "restoring %s never enables requested auto or widens native access",
    (variant) =>
      harness(async ({ host, home, sessions, scope }) => {
        const id = await seed(sessions, scope)
        await run(sessions.setSettings(id, { permission: "auto" }))
        const policy = workspacePolicy()
        await configure(home, {
          nativeSettings:
            variant === "readOnly"
              ? { ...policy, sandbox: { type: "readOnly", networkAccess: false } }
              : variant === "network"
                ? { ...policy, sandbox: { ...policy.sandbox, networkAccess: true } }
                : variant === "extraRoots"
                  ? workspacePolicy([path.join(directory, "extra")])
                  : { ...policy, approvalsReviewer: "auto_review" },
        })
        const snapshot = await run(host.snapshot(id))
        expect(snapshot.descriptor.settings.permission).toBe(variant === "readOnly" ? "readOnly" : undefined)
        expect(snapshot.descriptor.pendingSettings?.permission).toBe("auto")
        await command(home, [approval("old")])
        await until(
          () => run(host.snapshot(id)),
          (snapshot) => snapshot.interactions.length === 1,
        )
        expect(
          (await rpc(home)).some(
            (call) => call.id === "old" || call.method === "turn/start" || call.method === "thread/start",
          ),
        ).toBe(false)
      }),
  )

  test("legacy workspace is projected as default without pending migration or native writes", () =>
    harness(async ({ host, home, sessions, scope }) => {
      const id = await seed(sessions, scope)
      await run(sessions.setSettings(id, { permission: "workspace" }))
      await configure(home, { nativeSettings: workspacePolicy([]) })
      const snapshot = await run(host.snapshot(id))
      expect(snapshot.descriptor.settings.permission).toBe("default")
      expect(snapshot.descriptor.pendingSettings).toBeUndefined()
      expect((await run(sessions.get(id))).binding.settings).toEqual({ permission: "workspace" })
    }))

  test("an already resolved request is never automatically accepted", () =>
    harness(async ({ host, home, sessions, scope }) => {
      const id = await seed(sessions, scope)
      await configure(home, { nativeSettings: workspacePolicy() })
      await run(host.snapshot(id))
      await run(host.settings(id, { permission: "auto" }))
      await command(home, [
        approval("resolved"),
        { method: "serverRequest/resolved", params: { threadId: "native-thread", requestId: "resolved" } },
      ])
      const calls = await until(
        () => rpc(home),
        (calls) => calls.some((call) => call.id === "resolved"),
      )
      expect(calls.find((call) => call.id === "resolved")?.result).toBeUndefined()
      expect(calls.find((call) => call.id === "resolved")?.error).toBeDefined()
    }))

  test("reconnection cannot reuse an earlier generation's auto confirmation", () =>
    harness(async ({ host, home, sessions, scope }) => {
      const id = await seed(sessions, scope)
      await configure(home, { nativeSettings: workspacePolicy() })
      await run(host.snapshot(id))
      const before = await run(host.settings(id, { permission: "auto" }))
      await configure(home, {
        nativeSettings: { ...workspacePolicy(), sandbox: { type: "readOnly", networkAccess: false } },
      })
      await writeFile(path.join(home, "command.json"), JSON.stringify({ id: randomUUID(), exit: true }))
      await until(
        () => run(host.describe([id])),
        (items) => items[0]?.runtimeStatus === "disconnected",
      )
      await command(home, [])
      const snapshot = await run(host.snapshot(id))
      expect(snapshot.descriptor.epoch).not.toBe(before.epoch)
      expect(snapshot.descriptor.settings.permission).toBe("readOnly")
      expect(snapshot.descriptor.pendingSettings?.permission).toBe("auto")
      await command(home, [approval("new-generation")])
      await until(
        () => run(host.snapshot(id)),
        (snapshot) => snapshot.interactions.length === 1,
      )
      expect((await rpc(home)).some((call) => call.id === "new-generation")).toBe(false)
    }))

  test("syncs native read and name notifications through the Session title owner", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      await configure(home, { thread: { ...thread(), name: "Native read title" } })
      await run(host.snapshot(id))
      expect((await run(sessions.get(id))).session.title).toBe("Native read title")
      await command(home, [
        { method: "thread/name/updated", params: { threadId: "native-thread", threadName: "Native event title" } },
      ])
      await until(
        () => run(sessions.get(id)),
        (value) => value.session.title === "Native event title",
      )
    }))

  test("reads and resumes the same directory through a real symlink and canonical native cwd", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const alias = path.join(home, "workspace-alias")
      await symlink(directory, alias, "dir")
      const id = await seed(sessions, scope, Location.Ref.make({ directory: AbsolutePath.make(alias) }))
      await configure(home, { thread: { ...thread(), cwd: await realpath(alias) } })
      const snapshot = await run(host.snapshot(id))
      expect(snapshot.descriptor.runtimeStatus).toBe("idle")
      expect(snapshot.descriptor.error).toBeUndefined()
      expect((await run(sessions.get(id))).session.location.directory).toBe(AbsolutePath.make(alias))
      await run(host.submit(id, { requestID: "aliased-cwd", input: prompt, delivery: "steer" }))
      await until(
        () => run(host.delivery(id, "aliased-cwd")),
        (value) => value.state === "accepted",
      )
      expect((await rpc(home)).some((call) => call.method === "thread/resume")).toBe(true)
    }))

  test("canonical cwd checks still reject a different directory or native thread", async () => {
    for (const mismatch of ["directory", "thread", "missing"] as const) {
      await harness(async ({ host, sessions, scope, home }) => {
        const id = await seed(sessions, scope)
        await configure(home, {
          thread: {
            ...thread(),
            ...(mismatch === "thread"
              ? { id: "different-thread" }
              : {
                  cwd: mismatch === "directory" ? home : path.join(home, "missing-directory"),
                }),
          },
        })
        const snapshot = await run(host.snapshot(id))
        expect(snapshot.descriptor.runtimeStatus).toBe("bindingUnavailable")
        expect(snapshot.descriptor.error).toContain("different native thread or directory")
      })
    }
  })

  test("keeps an existing native login without reading provider credentials", () =>
    harness(
      async ({ host, home }) => {
        expect((await run(host.account())).authenticated).toBe(true)
        expect((await rpc(home)).some((call) => call.method === "account/login/start")).toBe(false)
      },
      undefined,
      {
        get: async () => {
          throw new Error("Provider credentials must not be read")
        },
        onSelection: () => () => {},
      },
    ))

  test("reuses provider login once and handles threadless refresh during login", async () => {
    const reads: Array<CodexAuth.Tokens | undefined> = []
    await harness(
      async ({ host, home }) => {
        await configure(home, { authenticated: false, refreshOnLogin: true })
        const accounts = await Promise.all([run(host.account()), run(host.account())])
        expect(accounts.every((account) => account.authenticated)).toBe(true)
        await until(
          () => rpc(home),
          (calls) => calls.some((call) => call.id === "login-refresh"),
        )
        expect((await rpc(home)).filter((call) => call.method === "account/login/start")).toHaveLength(1)
        expect((await rpc(home)).find((call) => call.id === "login-refresh")?.error).toBeUndefined()
        expect(reads).toHaveLength(2)
        expect(reads[1]?.chatgptAccountId).toBe("fixture-account")
        await command(home, [
          {
            id: "wrong-account",
            method: "account/chatgptAuthTokens/refresh",
            params: {
              reason: "unauthorized",
              previousAccountId: "different-account",
            },
          },
        ])
        await until(
          () => rpc(home),
          (calls) => calls.some((call) => call.id === "wrong-account"),
        )
        expect((await rpc(home)).find((call) => call.id === "wrong-account")?.error).toBeDefined()
        expect(reads).toHaveLength(2)
      },
      undefined,
      {
        get: async (previous) => {
          reads.push(previous)
          return {
            accessToken: previous ? "fixture-refreshed" : "fixture-initial",
            chatgptAccountId: "fixture-account",
            chatgptPlanType: null,
          }
        },
        onSelection: () => () => {},
      },
    )
  })

  test("selection changes invalidate an in-flight native refresh and clear only the imported login", async () => {
    let selection = () => {}
    let finish = (_value: CodexAuth.Tokens | undefined) => {}
    let refreshing = false
    const tokens = { accessToken: "fixture-initial", chatgptAccountId: "fixture-account", chatgptPlanType: null }
    await harness(
      async ({ host, home }) => {
        await configure(home, { authenticated: false })
        expect((await run(host.account())).authenticated).toBe(true)
        await command(home, [
          {
            id: "late-refresh",
            method: "account/chatgptAuthTokens/refresh",
            params: {
              reason: "unauthorized",
              previousAccountId: tokens.chatgptAccountId,
            },
          },
        ])
        await until(async () => refreshing, Boolean)
        selection()
        finish({ ...tokens, accessToken: "fixture-late" })
        await until(
          () => rpc(home),
          (calls) => calls.some((call) => call.id === "late-refresh"),
        )
        expect((await rpc(home)).find((call) => call.id === "late-refresh")?.error).toBeDefined()
        await until(
          () => rpc(home),
          (calls) => calls.some((call) => call.method === "account/logout"),
        )
      },
      undefined,
      {
        get: async (previous) => {
          if (!previous) return tokens
          refreshing = true
          return new Promise((resolve) => {
            finish = resolve
          })
        },
        onSelection: (listener) => {
          selection = listener
          return () => {}
        },
      },
    )
  })

  test("provider selection cannot log out an independently logged-in native account", async () => {
    let selection = () => {}
    await harness(
      async ({ host, home }) => {
        expect((await run(host.account())).authenticated).toBe(true)
        selection()
        expect((await run(host.account())).authenticated).toBe(true)
        expect((await rpc(home)).some((call) => call.method === "account/logout")).toBe(false)
      },
      undefined,
      {
        get: async () => {
          throw new Error("Must not read provider auth")
        },
        onSelection: (listener) => {
          selection = listener
          return () => {}
        },
      },
    )
  })

  test("two selections during import still log out the old external credential", async () => {
    let selection = () => {}
    let available = true
    await harness(
      async ({ host, home }) => {
        await configure(home, { authenticated: false, delayLogin: true })
        const account = run(host.account())
        await until(
          () => rpc(home),
          (calls) => calls.some((call) => call.method === "account/login/start"),
        )
        available = false
        selection()
        selection()
        await account
        await until(
          () => rpc(home),
          (calls) => calls.some((call) => call.method === "account/logout"),
        )
        expect((await run(host.account())).authenticated).toBe(false)
        expect((await rpc(home)).filter((call) => call.method === "account/logout")).toHaveLength(1)
      },
      undefined,
      {
        get: async () =>
          available
            ? { accessToken: "fixture-initial", chatgptAccountId: "fixture-account", chatgptPlanType: null }
            : undefined,
        onSelection: (listener) => {
          selection = listener
          return () => {}
        },
      },
    )
  })

  test("lease refusal leaves native binding and input unclaimed", () =>
    harness(async ({ host, sessions, home, gate }) => {
      gate.refuse = true
      const created = await run(
        host.create({ requestID: "first", engine: "codex", location: location(), input: prompt, delivery: "steer" }),
      )
      await until(
        () => run(host.describe([created.descriptor.sessionID])),
        (values) => !!values[0]?.error,
      )
      expect((await run(sessions.get(created.descriptor.sessionID))).binding.state).toBe("pending")
      expect((await run(host.delivery(created.descriptor.sessionID, "first"))).state).toBe("pending")
      expect((await rpc(home)).some((call) => call.method === "thread/start")).toBe(false)
      gate.refuse = false
      const retried = await run(
        host.create({ requestID: "first", engine: "codex", location: location(), input: prompt, delivery: "steer" }),
      )
      expect(retried.descriptor.sessionID).toBe(created.descriptor.sessionID)
      await until(
        () => run(host.delivery(created.descriptor.sessionID, "first")),
        (receipt) => receipt.state === "accepted",
      )
      expect((await rpc(home)).filter((call) => call.method === "thread/start")).toHaveLength(1)
    }))

  test("bound session lease refusal leaves admitted delivery pending", () =>
    harness(async ({ host, sessions, home, scope, gate }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      gate.refuse = true
      await run(host.submit(id, { requestID: "blocked", input: prompt, delivery: "steer" }))
      await until(
        () => run(host.describe([id])),
        (values) => values[0]?.error?.includes("Archive gate") === true,
      )
      expect((await run(host.delivery(id, "blocked"))).state).toBe("pending")
      expect((await rpc(home)).some((call) => call.method === "turn/start")).toBe(false)
    }))

  test("archived sessions reject new input and explicit queue resume before native execution", () =>
    harness(async ({ host, sessions, database, home, scope }) => {
      const id = await seed(sessions, scope)
      await run(sessions.admit({ sessionID: id, requestID: "queued", payload: prompt, delivery: "queue" }))
      await run(sessions.admit({ sessionID: id, requestID: "withdraw", payload: prompt, delivery: "queue" }))
      await run(sessions.setQueuePaused(id, true))
      const snapshot = await run(host.snapshot(id))
      await run(database.db.update(SessionTable).set({ time_archived: Date.now() }).run().pipe(Effect.orDie))
      const starts = (await rpc(home)).filter((call) => call.method === "turn/start").length

      await expect(
        run(host.submit(id, { requestID: "archived-new", input: prompt, delivery: "steer" })),
      ).rejects.toThrow("is archived")
      await expect(
        run(host.queue(id, { action: "resume", requestID: "queued", revision: snapshot.descriptor.revision })),
      ).rejects.toThrow("is archived")
      expect(await run(sessions.getDelivery({ sessionID: id, requestID: "archived-new" }))).toBeUndefined()
      expect((await run(host.delivery(id, "queued"))).state).toBe("pending")
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(starts)

      await run(host.queue(id, { action: "withdraw", requestID: "withdraw", revision: snapshot.descriptor.revision }))
      expect((await run(host.delivery(id, "withdraw"))).state).toBe("withdrawn")
      await run(database.db.update(SessionTable).set({ time_archived: null }).run().pipe(Effect.orDie))
      const restored = await run(host.snapshot(id))
      await run(host.queue(id, { action: "resume", requestID: "queued", revision: restored.descriptor.revision }))
      await until(
        () => run(host.delivery(id, "queued")),
        (delivery) => delivery.state === "accepted",
      )
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(starts + 1)
    }))

  test("archived sessions reject an existing create receipt before native execution", () =>
    harness(async ({ host, sessions, database, home, scope }) => {
      const request = {
        runtimeScope: scope,
        requestID: "archived-create-retry",
        engine: "codex" as const,
        location: location(),
        payload: prompt,
        settings: {},
        delivery: "steer" as const,
      }
      const created = await run(sessions.create(request))
      await run(sessions.claimBinding({ sessionID: created.session.id, generation: "seed" }))
      await run(sessions.bind({ sessionID: created.session.id, nativeThreadID: "native-thread", generation: "seed" }))
      await run(database.db.update(SessionTable).set({ time_archived: Date.now() }).run().pipe(Effect.orDie))

      await expect(
        run(
          host.create({
            requestID: request.requestID,
            engine: "codex",
            location: request.location,
            input: prompt,
            delivery: request.delivery,
          }),
        ),
      ).rejects.toThrow("is archived")
      expect((await run(host.delivery(created.session.id, request.requestID))).state).toBe("pending")
      expect((await rpc(home)).some((call) => ["thread/start", "turn/start"].includes(call.method ?? ""))).toBe(false)

      await run(database.db.update(SessionTable).set({ time_archived: null }).run().pipe(Effect.orDie))
      await run(
        host.create({
          requestID: request.requestID,
          engine: "codex",
          location: request.location,
          input: prompt,
          delivery: request.delivery,
        }),
      )
      await until(
        () => run(host.delivery(created.session.id, request.requestID)),
        (delivery) => delivery.state === "accepted",
      )
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(1)
    }))

  test("snapshot-covered deltas never duplicate text and active turn is reconstructed", () =>
    harness(async ({ host, sessions, home, scope }) => {
      const id = await seed(sessions, scope)
      const native = thread()
      native.status = { type: "active", activeFlags: [] }
      native.turns = [
        {
          id: "running",
          items: [
            {
              type: "agentMessage",
              id: "answer",
              text: "AB",
              phase: null,
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          ],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      ]
      await configure(home, {
        thread: native,
        readEvents: [
          {
            method: "item/agentMessage/delta",
            params: { threadId: native.id, turnId: "running", itemId: "answer", delta: "B" },
          },
        ],
      })
      await run(host.snapshot(id))
      await Bun.sleep(40)
      const snapshot = await run(host.snapshot(id))
      expect(JSON.stringify(snapshot.messages)).toContain('"text":"AB"')
      expect(JSON.stringify(snapshot.messages)).not.toContain('"text":"ABB"')
      await run(host.interrupt(id))
      expect((await rpc(home)).some((call) => call.method === "turn/interrupt")).toBe(true)
    }))

  test("disconnect reconciles unknown delivery only from exact client ID without resending", () =>
    harness(async ({ host, sessions, home }) => {
      await configure(home, { disconnectTurn: true })
      const created = await run(
        host.create({
          requestID: "uncertain",
          engine: "codex",
          location: location(),
          input: prompt,
          delivery: "steer",
        }),
      )
      const id = created.descriptor.sessionID
      await until(
        () => run(host.delivery(id, "uncertain")),
        (receipt) => receipt.state === "unknown",
      )
      const snapshot = await run(host.snapshot(id))
      expect(snapshot.deliveries.find((receipt) => receipt.requestID === "uncertain")?.state).toBe("accepted")
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(1)
      expect((await run(sessions.get(id))).binding.queuePaused).toBe(true)
    }))

  test("offline exact retries reuse frozen attachments and conflicting reuse fails", () =>
    harness(async ({ host, home }) => {
      const file = path.join(home, "image.png")
      await writeFile(file, "first-bytes")
      const input = {
        ...prompt,
        prompt: { text: "image", files: [{ uri: pathToFileURL(file).href, mime: "image/png" }] },
      }
      const request = {
        requestID: "image-request",
        engine: "codex" as const,
        location: location(),
        input,
        delivery: "steer" as const,
      }
      const created = await run(host.create(request))
      await until(
        () => run(host.delivery(created.descriptor.sessionID, request.requestID)),
        (receipt) => receipt.state === "accepted",
      )
      await writeFile(file, "changed-bytes")
      await configure(home, { authenticated: false })
      const retried = await run(host.create(request))
      expect(retried.descriptor.sessionID).toBe(created.descriptor.sessionID)
      expect(retried.delivery.input.prompt.files?.[0]?.uri).toContain(Buffer.from("first-bytes").toString("base64"))
      await expect(run(host.create({ ...request, input: { ...input, prompt: { text: "changed" } } }))).rejects.toThrow(
        "different input",
      )
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(1)
    }))

  test("native login failure stays visible until the next login attempt", () =>
    harness(async ({ host, home }) => {
      await configure(home, { authenticated: false })
      const login = await run(host.login())
      await command(home, [
        {
          method: "account/login/completed",
          params: { loginId: login.loginID, success: false, error: "Login callback timed out" },
        },
      ])
      const failed = await until(
        () => run(host.account()),
        (value) => value.loginState === "failed",
      )
      expect(failed.authenticated).toBe(false)
      expect(failed.loginID).toBeUndefined()
      expect(failed.error).toBe("Login callback timed out")
      await run(host.login())
      const pending = await run(host.account())
      expect(pending.loginState).toBe("pending")
      expect(pending.error).toBeUndefined()
    }))

  test("login is coalesced and desired settings do not become applied before native confirmation", () =>
    harness(async ({ host, sessions, scope, home }) => {
      await Promise.all([run(host.login()), run(host.login())])
      expect((await rpc(home)).filter((call) => call.method === "account/login/start")).toHaveLength(1)
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      const descriptor = await run(host.settings(id, { effort: "high" }))
      expect(descriptor.settings.effort).toBe("low")
      expect(descriptor.pendingSettings?.effort).toBe("high")
      expect((await run(host.settings(id, { effort: "low" }))).pendingSettings).toBeUndefined()
      expect((await run(host.settings(id, {}))).pendingSettings).toBeUndefined()
    }))

  test("native nonblocking question stays active and a resolved request cannot be answered", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      await run(host.submit(id, { requestID: "active", input: prompt, delivery: "steer" }))
      await until(
        () => run(host.delivery(id, "active")),
        (receipt) => receipt.state === "accepted",
      )
      await command(home, [
        {
          id: 1,
          method: "item/tool/requestUserInput",
          params: {
            threadId: "native-thread",
            turnId: "turn-1",
            itemId: "ask",
            isBlocking: false,
            questions: [
              { id: "q", header: "Question", question: "Continue?", options: null, isOther: true, isSecret: false },
            ],
          },
        },
      ])
      const waiting = await until(
        () => run(host.snapshot(id)),
        (snapshot) => snapshot.interactions.length === 1,
      )
      expect(waiting.descriptor.runtimeStatus).toBe("active")
      const interaction = waiting.interactions[0]!
      expect(interaction.id).toMatch(/^codex-[a-f0-9]{64}$/)
      expect(interaction.id.length).toBeLessThanOrEqual(100)
      await command(home, [{ method: "serverRequest/resolved", params: { threadId: "native-thread", requestId: 1 } }])
      await until(
        () => run(host.snapshot(id)),
        (snapshot) => snapshot.interactions.length === 0,
      )
      await expect(
        run(host.reply(id, interaction.id, { revision: interaction.revision, answers: { q: ["yes"] } })),
      ).rejects.toThrow("no longer pending")
    }))
  test("unknown input with no unique native client ID remains blocked and visible", () =>
    harness(async ({ host, sessions, home, scope }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      await run(sessions.admit({ sessionID: id, requestID: "lost", payload: prompt, delivery: "steer" }))
      await run(sessions.claim({ sessionID: id, requestID: "lost", generation: "original-attempt" }))
      await run(sessions.settle({ sessionID: id, requestID: "lost", generation: "original-attempt", state: "unknown" }))
      await run(
        host.queue(id, {
          action: "resume",
          requestID: "",
          revision: (await run(host.snapshot(id))).descriptor.revision,
        }),
      )
      const snapshot = await run(host.snapshot(id))
      expect(snapshot.descriptor.error).toContain("no")
      expect((await run(host.delivery(id, "lost"))).state).toBe("unknown")
      await run(host.submit(id, { requestID: "after", input: prompt, delivery: "steer" }))
      await Bun.sleep(30)
      expect((await run(host.delivery(id, "after"))).state).toBe("pending")
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(0)
    }))

  test("rollout fallback survives metadata and usage events", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      const file = path.join(home, "sessions", "rollout.jsonl")
      await mkdir(path.dirname(file), { recursive: true })
      const content = (await readFile(path.join(import.meta.dir, "fixture/rollout.jsonl"), "utf8")).replaceAll(
        "thread-fixture",
        "native-thread",
      )
      await writeFile(file, content)
      await configure(home, { thread: { ...thread(), path: file }, readError: true })
      const first = await run(host.snapshot(id))
      expect(first.messages.length).toBeGreaterThan(0)
      await command(home, [
        { method: "thread/status/changed", params: { threadId: "native-thread", status: { type: "idle" } } },
      ])
      const next = await until(
        () => run(host.snapshot(id)),
        (value) => value.descriptor.revision > first.descriptor.revision,
      )
      expect(next.messages).toEqual(first.messages)
    }))

  test("interaction IDs cannot collide across backend epochs using the same home and RPC ID", async () => {
    const question = {
      id: 1,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "native-thread",
        turnId: "turn-1",
        itemId: "ask",
        isBlocking: false,
        questions: [
          { id: "q", header: "Question", question: "Continue?", options: null, isOther: true, isSecret: false },
        ],
      },
    }
    const previous = await harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      await command(home, [question])
      const snapshot = await until(
        () => run(host.snapshot(id)),
        (value) => value.interactions.length === 1,
      )
      return { home, interaction: snapshot.interactions[0]! }
    })
    await harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      await command(home, [question])
      const snapshot = await until(
        () => run(host.snapshot(id)),
        (value) => value.interactions.length === 1,
      )
      expect(snapshot.interactions[0]!.id).not.toBe(previous.interaction.id)
      await expect(
        run(
          host.reply(id, previous.interaction.id, {
            revision: snapshot.interactions[0]!.revision,
            answers: { q: ["yes"] },
          }),
        ),
      ).rejects.toThrow("no longer pending")
      expect((await run(host.snapshot(id))).interactions[0]!.state).toBe("pending")
    }, previous.home)
  })

  test("new items stream with native timing while complete items reject late deltas", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      await run(host.submit(id, { requestID: "stream", input: prompt, delivery: "steer" }))
      await until(
        () => run(host.delivery(id, "stream")),
        (receipt) => receipt.state === "accepted",
      )
      const item: v2.ThreadItem = {
        type: "agentMessage",
        id: "new-answer",
        text: "A",
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      }
      await command(home, [
        { method: "item/started", params: { threadId: "native-thread", turnId: "turn-1", item, startedAtMs: 1234 } },
        {
          method: "item/agentMessage/delta",
          params: { threadId: "native-thread", turnId: "turn-1", itemId: item.id, delta: "B" },
        },
      ])
      const streamed = await until(
        () => run(host.snapshot(id)),
        (value) => JSON.stringify(value.messages).includes('"text":"AB"'),
      )
      expect(JSON.stringify(streamed.messages)).toContain('"created":1234')
      const persisted = JSON.parse(await readFile(path.join(home, "fixture.json"), "utf8")) as { thread: v2.Thread }
      persisted.thread.turns[0]!.items.push({ ...item, text: "ABC" })
      await configure(home, persisted)
      await command(home, [
        {
          method: "item/completed",
          params: { threadId: "native-thread", turnId: "turn-1", item: { ...item, text: "ABC" }, completedAtMs: 2345 },
        },
        {
          method: "item/agentMessage/delta",
          params: { threadId: "native-thread", turnId: "turn-1", itemId: item.id, delta: "C" },
        },
      ])
      const completed = await until(
        () => run(host.snapshot(id)),
        (value) => JSON.stringify(value.messages).includes('"completed":2345'),
      )
      expect(JSON.stringify(completed.messages)).toContain('"text":"ABC"')
      expect(JSON.stringify(completed.messages)).not.toContain('"text":"ABCC"')
    }))

  test("failed native turn expires blocking approvals and pauses queued inputs", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      await run(host.submit(id, { requestID: "failure", input: prompt, delivery: "steer" }))
      await until(
        () => run(host.delivery(id, "failure")),
        (receipt) => receipt.state === "accepted",
      )
      await command(home, [
        {
          id: "approval",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "native-thread",
            turnId: "turn-1",
            itemId: "command",
            command: "touch file",
            cwd: directory,
            availableDecisions: ["accept", "decline"],
          },
        },
      ])
      await until(
        () => run(host.snapshot(id)),
        (value) => value.interactions.length === 1,
      )
      await command(home, [
        {
          method: "turn/completed",
          params: {
            threadId: "native-thread",
            turn: {
              id: "turn-1",
              items: [],
              itemsView: "full",
              status: "failed",
              error: { message: "Native model failed", codexErrorInfo: null, additionalDetails: null },
              startedAt: 1,
              completedAt: 2,
              durationMs: 1000,
            },
          },
        },
      ])
      const snapshot = await until(
        () => run(host.snapshot(id)),
        (value) => value.interactions.length === 0,
      )
      expect(snapshot.descriptor.runtimeStatus).toBe("idle")
      expect(snapshot.descriptor.error).toBe("Native model failed")
      expect(snapshot.descriptor.queuePaused).toBe(true)
    }))

  test("unsupported native requests return a protocol error and display the reason", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      await command(home, [{ id: "unsupported", method: "fixture/unsupported", params: { threadId: "native-thread" } }])
      const snapshot = await until(
        () => run(host.snapshot(id)),
        (value) => !!value.descriptor.error,
      )
      expect(snapshot.descriptor.error).toContain("Unsupported native request")
      await until(
        () => rpc(home),
        (calls) => calls.some((call) => call.id === "unsupported" && !!call.error),
      )
      expect(snapshot.interactions).toHaveLength(0)
    }))

  test("idle signal during resume schedules a fresh read and drains already admitted input", () =>
    harness(async ({ host, sessions, scope, home }) => {
      await run(host.account())
      const id = await seed(sessions, scope)
      await run(sessions.admit({ sessionID: id, requestID: "queued-before-read", payload: prompt, delivery: "queue" }))
      await configure(home, {
        resumeEvents: [
          { method: "thread/status/changed", params: { threadId: "native-thread", status: { type: "idle" } } },
        ],
      })
      await run(host.snapshot(id))
      await until(
        () => run(host.delivery(id, "queued-before-read")),
        (receipt) => receipt.state === "accepted",
      )
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(1)
      expect((await rpc(home)).filter((call) => call.method === "thread/read").length).toBeGreaterThanOrEqual(4)
    }))

  test("read-overlapping start and completion are reconciled by a bounded fresh snapshot", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      const completed: v2.Turn = {
        id: "overlap",
        items: [
          {
            type: "agentMessage",
            id: "overlap-answer",
            text: "completed during read",
            phase: null,
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
        ],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      }
      await configure(home, {
        afterReadThread: { ...thread(), turns: [completed] },
        readEvents: [
          {
            method: "turn/started",
            params: { threadId: "native-thread", turn: { ...completed, items: [], status: "inProgress" } },
          },
          { method: "turn/completed", params: { threadId: "native-thread", turn: completed } },
        ],
      })
      await run(host.snapshot(id))
      await Bun.sleep(350)
      const snapshot = await run(host.snapshot(id))
      expect(JSON.stringify(snapshot.messages)).toContain("completed during read")
      expect(snapshot.descriptor.runtimeStatus).toBe("idle")
      expect((await rpc(home)).filter((call) => call.method === "thread/read").length).toBeGreaterThanOrEqual(4)
      expect((await rpc(home)).filter((call) => call.method === "thread/read").length).toBeLessThanOrEqual(6)
    }))

  test("ambiguous streaming deltas refresh text without waiting for item completion", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      const native = thread()
      native.status = { type: "active", activeFlags: [] }
      native.turns = [
        {
          id: "running",
          items: [
            {
              type: "agentMessage",
              id: "answer",
              text: "A",
              phase: null,
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          ],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      ]
      await configure(home, { thread: native })
      await run(host.snapshot(id))
      native.turns[0]!.items = [{ ...native.turns[0]!.items[0]!, text: "AB" } as v2.ThreadItem]
      await configure(home, { thread: native })
      await command(
        home,
        Array.from({ length: 20 }, () => ({
          method: "item/agentMessage/delta",
          params: { threadId: "native-thread", turnId: "running", itemId: "answer", delta: "B" },
        })),
      )
      await Bun.sleep(350)
      const snapshot = await run(host.snapshot(id))
      expect(JSON.stringify(snapshot.messages)).toContain('"text":"AB"')
      expect(JSON.stringify(snapshot.messages)).not.toContain('"text":"ABB"')
      expect((await rpc(home)).filter((call) => call.method === "thread/read")).toHaveLength(4)
    }))
  test("interrupted turn retains its lease and paused queue until the native command actually completes", () =>
    harness(async ({ host, sessions, scope, home, gate }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      await run(host.submit(id, { requestID: "long-native", input: prompt, delivery: "steer" }))
      await until(
        () => run(host.delivery(id, "long-native")),
        (receipt) => receipt.state === "accepted",
      )
      const item: v2.ThreadItem = {
        type: "commandExecution",
        id: "running-command",
        pluginId: null,
        scriptPath: null,
        command: "sleep 3",
        cwd: directory,
        processId: "native-process",
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      }
      await command(home, [
        { method: "item/started", params: { threadId: "native-thread", turnId: "turn-1", item, startedAtMs: 10 } },
      ])
      await until(
        () => run(host.snapshot(id)),
        (value) => JSON.stringify(value.messages).includes("running-command"),
      )
      await run(host.submit(id, { requestID: "queued-after-stop", input: prompt, delivery: "queue" }))
      await run(host.interrupt(id))
      const released = gate.released
      const turn: v2.Turn = {
        id: "turn-1",
        items: [item],
        itemsView: "full",
        status: "interrupted",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      }
      await configure(home, { thread: { ...thread(), turns: [turn] } })
      await command(home, [
        { method: "thread/status/changed", params: { threadId: "native-thread", status: { type: "idle" } } },
        { method: "turn/completed", params: { threadId: "native-thread", turn } },
      ])
      await Bun.sleep(30)
      const stopping = await run(host.snapshot(id))
      expect(stopping.descriptor.runtimeStatus).toBe("interrupting")
      expect(gate.released).toBe(released)
      expect((await run(sessions.get(id))).binding.executionPending).toBe(true)
      expect((await run(host.delivery(id, "queued-after-stop"))).state).toBe("pending")
      const completed = { ...item, status: "completed", exitCode: 0, durationMs: 3000 } as v2.ThreadItem
      await configure(home, { thread: { ...thread(), turns: [{ ...turn, items: [completed] }] } })
      await command(home, [
        {
          method: "item/completed",
          params: { threadId: "native-thread", turnId: "turn-1", item: completed, completedAtMs: 3010 },
        },
      ])
      await until(
        () => run(host.snapshot(id)),
        (value) => value.descriptor.runtimeStatus === "idle",
      )
      expect(gate.released).toBe(released + 1)
      expect((await run(sessions.get(id))).binding.executionPending).toBe(false)
      expect((await run(host.delivery(id, "queued-after-stop"))).state).toBe("pending")
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(1)
    }))

  test("recovered durable executionPending cannot be cleared by an idle snapshot or new input", () =>
    harness(async ({ host, sessions, scope, home, gate }) => {
      const id = await seed(sessions, scope)
      await run(sessions.setExecutionPending(id, true))
      const snapshot = await run(host.snapshot(id))
      expect(snapshot.descriptor.runtimeStatus).toBe("disconnected")
      expect(snapshot.descriptor.capabilities.prompt).toBe(false)
      expect(snapshot.descriptor.error).toContain("no confirmed completion")
      expect((await run(sessions.get(id))).binding.executionPending).toBe(true)
      await expect(run(host.submit(id, { requestID: "unsafe-new", input: prompt, delivery: "steer" }))).rejects.toThrow(
        "not been confirmed finished",
      )
      expect(await run(sessions.getDelivery({ sessionID: id, requestID: "unsafe-new" }))).toBeUndefined()
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(0)
      expect(gate.released).toBe(0)
    }))
  test("opaque interaction IDs distinguish numeric and string RPC IDs below the router length limit", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      const params = {
        threadId: "native-thread",
        turnId: "turn-1",
        itemId: "ask",
        isBlocking: false,
        questions: [
          { id: "q", header: "Question", question: "Continue?", options: null, isOther: true, isSecret: false },
        ],
      }
      await command(home, [
        { id: 1, method: "item/tool/requestUserInput", params },
        { id: "1", method: "item/tool/requestUserInput", params },
      ])
      const snapshot = await until(
        () => run(host.snapshot(id)),
        (value) => value.interactions.length === 2,
      )
      expect(new Set(snapshot.interactions.map((value) => value.id)).size).toBe(2)
      expect(
        snapshot.interactions.every((value) => /^codex-[a-f0-9]{64}$/.test(value.id) && value.id.length <= 100),
      ).toBe(true)
    }))

  test("native plans are validated live data and become unavailable after reconnect", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const config = "[tools.update_plan]\nenabled = false\n"
      await writeFile(path.join(home, "config.toml"), config)
      const id = await seed(sessions, scope)
      await run(host.snapshot(id))
      expect(JSON.parse((await readFile(path.join(home, "starts.jsonl"), "utf8")).trim())).toEqual([
        "app-server",
        "--stdio",
        "-c",
        "tools.update_plan.enabled=true",
      ])
      await command(home, [
        {
          method: "turn/plan/updated",
          params: {
            threadId: "native-thread",
            turnId: "plan-turn",
            explanation: "Native plan",
            plan: [{ step: "Read the fixture", status: "inProgress" }],
          },
        },
      ])
      const snapshot = await until(
        () => run(host.snapshot(id)),
        (value) => value.plan?.status === "available",
      )
      expect(snapshot.plan).toEqual({
        status: "available",
        value: {
          turnID: "plan-turn",
          explanation: "Native plan",
          steps: [{ step: "Read the fixture", status: "inProgress" }],
        },
      })
      await command(home, [
        {
          method: "turn/plan/updated",
          params: { threadId: "native-thread", turnId: "plan-turn", plan: [{ step: "bad", status: "invented" }] },
        },
      ])
      await Bun.sleep(30)
      expect((await run(host.snapshot(id))).plan).toEqual(snapshot.plan)
      await writeFile(path.join(home, "command.json"), JSON.stringify({ id: randomUUID(), exit: true }))
      await Bun.sleep(40)
      const restored = await run(host.snapshot(id))
      expect(restored.plan).toEqual({ status: "unavailable" })
      const starts = (await readFile(path.join(home, "starts.jsonl"), "utf8")).trim().split("\n")
      expect(starts).toHaveLength(2)
      expect(starts[1]).toBe(starts[0])
      expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(config)
    }))

  test("summary turn completion retains streamed user and tool identities", () =>
    harness(async ({ host, home }) => {
      const created = await run(
        host.create({ requestID: "first", engine: "codex", location: location(), input: prompt, delivery: "steer" }),
      )
      const id = created.descriptor.sessionID
      await until(
        () => run(host.delivery(id, "first")),
        (receipt) => receipt.state === "accepted",
      )
      const user = {
        type: "userMessage",
        id: "user-summary",
        clientId: "first",
        content: [{ type: "text", text: "keep my input", text_elements: [] }],
      }
      const assistant = {
        type: "agentMessage",
        id: "assistant-summary",
        text: "done",
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      }
      await command(home, [
        { method: "item/started", params: { threadId: "native-thread", turnId: "turn-1", item: user } },
        { method: "item/completed", params: { threadId: "native-thread", turnId: "turn-1", item: user } },
        { method: "item/completed", params: { threadId: "native-thread", turnId: "turn-1", item: assistant } },
        {
          method: "turn/completed",
          params: {
            threadId: "native-thread",
            turn: {
              id: "turn-1",
              items: [assistant],
              itemsView: "summary",
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1000,
            },
          },
        },
      ])
      const snapshot = await until(
        () => run(host.snapshot(id)),
        (value) => value.descriptor.runtimeStatus === "idle",
      )
      expect(snapshot.messages.some((message) => message.type === "user" && message.text === "keep my input")).toBe(
        true,
      )
      expect(snapshot.messages.filter((message) => message.id.endsWith("assistant-summary"))).toHaveLength(1)
    }))

  test("paged empty history proves a bound first input has never been dispatched", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const created = await run(
        sessions.create({
          runtimeScope: scope,
          requestID: "first",
          engine: "codex",
          location: location(),
          payload: prompt,
          delivery: "steer",
        }),
      )
      await run(sessions.claimBinding({ sessionID: created.session.id, generation: "old-host" }))
      await run(
        sessions.bind({ sessionID: created.session.id, generation: "old-host", nativeThreadID: "native-thread" }),
      )
      await run(sessions.setExecutionPending(created.session.id, true))
      await configure(home, { thread: { ...thread(), historyMode: "paginated" } })
      const snapshot = await run(host.snapshot(created.session.id))
      expect(snapshot.descriptor.runtimeStatus).toBe("idle")
      expect(snapshot.descriptor.capabilities.prompt).toBe(true)
      expect((await run(sessions.get(created.session.id))).binding.executionPending).toBe(false)
      expect((await run(host.delivery(created.session.id, "first"))).state).toBe("pending")
      expect((await rpc(home)).filter((call) => call.method === "turn/start")).toHaveLength(0)
    }))

  test("spawn and wait references list one bound child session", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const parent = await seed(sessions, scope)
      const child = await run(
        sessions.adoptChild({
          parentID: parent,
          runtimeScope: scope,
          nativeThreadID: "native-child",
          location: location(),
        }),
      )
      const items: v2.ThreadItem[] = (["spawnAgent", "wait"] as const).map((tool) => ({
        type: "collabAgentToolCall",
        id: tool,
        tool,
        status: "completed",
        senderThreadId: "native-thread",
        receiverThreadIds: ["native-child"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      }))
      await configure(home, {
        thread: {
          ...thread(),
          turns: [
            {
              id: "parent-turn",
              items,
              itemsView: "full",
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1,
            },
          ],
        },
        threads: {
          "native-child": {
            ...thread(),
            id: "native-child",
            parentThreadId: "native-thread",
            historyMode: "paginated",
          },
        },
      })
      const snapshot = await run(host.snapshot(parent))
      expect(snapshot.children).toEqual([{ sessionID: child.session.id, nativeThreadID: "native-child" }])
      expect(snapshot.messages).toHaveLength(2)
    }))

  test("a child discovered from history is usable when paginated native tools are explicitly complete", () =>
    harness(async ({ host, sessions, scope, home }) => {
      const parent = await seed(sessions, scope)
      const child = await run(
        sessions.adoptChild({
          parentID: parent,
          runtimeScope: scope,
          nativeThreadID: "native-child",
          location: location(),
        }),
      )
      const item: v2.ThreadItem = {
        type: "commandExecution",
        id: "child-command",
        pluginId: null,
        scriptPath: null,
        command: "cat sample.txt",
        cwd: directory,
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "done",
        exitCode: 0,
        durationMs: 1,
      }
      await configure(home, {
        threads: {
          "native-child": {
            ...thread(),
            id: "native-child",
            parentThreadId: "native-thread",
            historyMode: "paginated",
            turns: [
              {
                id: "child-turn",
                items: [item],
                itemsView: "full",
                status: "completed",
                error: null,
                startedAt: 1,
                completedAt: 2,
                durationMs: 1,
              },
            ],
          },
        },
      })
      const snapshot = await run(host.snapshot(child.session.id))
      expect(snapshot.descriptor.runtimeStatus).toBe("idle")
      expect(snapshot.descriptor.capabilities.prompt).toBe(true)
      expect((await run(sessions.get(child.session.id))).binding.executionPending).toBe(false)
      expect(JSON.stringify(snapshot.messages)).toContain("child-command")
    }))
})
