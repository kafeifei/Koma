import { afterAll, beforeAll, describe, expect } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionExternalBindingTable } from "@opencode-ai/core/session/external/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const environment = ["OPENCODE_ENABLE_CODEX", "OPENCODE_CODEX_HOME", "OPENCODE_CODEX_BINARY", "CODEX_HOME"]
const previous = new Map(environment.map((key) => [key, process.env[key]]))
let fixtureRoot: string
let nativeHome: string

beforeAll(async () => {
  delete process.env.CODEX_HOME
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "native-session-delete-"))
  nativeHome = path.join(fixtureRoot, "home")
  await mkdir(nativeHome)
  const binary = path.join(fixtureRoot, "codex-fixture")
  await writeFile(
    binary,
    `#!${process.execPath}\nawait import(${JSON.stringify(path.join(import.meta.dir, "../../../codex/test/fixture/host-peer.ts"))})\n`,
  )
  await chmod(binary, 0o755)
  process.env.OPENCODE_ENABLE_CODEX = "1"
  process.env.OPENCODE_CODEX_HOME = nativeHome
  process.env.OPENCODE_CODEX_BINARY = binary
})

afterAll(async () => {
  await disposeAllInstances()
  await resetDatabase()
  await rm(fixtureRoot, { recursive: true, force: true })
  environment.forEach((key) => {
    const value = previous.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))

describe("native Session delete HTTP routing", () => {
  it.instance("maps an active Codex Host refusal to 409 in V1 and V2 without deleting", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* Session.Service
      const database = yield* Database.Service
      const info = yield* session.create({ title: "Active native task" })
      const now = Date.now()
      yield* database.db
        .update(SessionTable)
        .set({ engine: "codex" })
        .where(eq(SessionTable.id, info.id))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionExternalBindingTable)
        .values({
          session_id: info.id,
          runtime_scope: `codex:${createHash("sha256").update(nativeHome).digest("hex")}`,
          native_thread_id: "native-thread",
          state: "bound",
          queue_paused: false,
          execution_pending: false,
          settings: {},
          projection_version: 1,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeFile(
          path.join(nativeHome, "fixture.json"),
          JSON.stringify({
            thread: {
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
              status: { type: "active", activeFlags: [] },
              path: null,
              cwd: test.directory,
              cliVersion: "0.153.4",
              source: "appServer",
              canAcceptDirectInput: true,
              threadSource: null,
              agentNickname: null,
              agentRole: null,
              gitInfo: null,
              name: null,
              turns: [],
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        writeFile(path.join(nativeHome, "command.json"), JSON.stringify({ id: randomUUID(), messages: [] })),
      )
      const v1 = yield* requestInDirectory(`/session/${info.id}`, test.directory, { method: "DELETE" })
      const v2 = yield* requestInDirectory(`/api/session/${info.id}`, test.directory, { method: "DELETE" })

      expect(v1.status).toBe(409)
      expect(v2.status).toBe(409)
      expect(yield* v1.json).toMatchObject({ _tag: "ConflictError" })
      expect(yield* v2.json).toMatchObject({ _tag: "ConflictError" })
      expect((yield* session.get(info.id)).engine).toBe("codex")
      const rpc = (yield* Effect.promise(() => readFile(path.join(nativeHome, "rpc.jsonl"), "utf8")))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method?: string })
      expect(rpc.some((call) => call.method === "thread/delete")).toBe(false)
    }),
  )
})
