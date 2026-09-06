import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { CodexRuntime } from "../src/session.js"
import { CodexRpcError } from "../src/transport.js"

const root = resolve(".cache", `history-modes-${Date.now()}-${process.pid}`)
const codexHome = resolve(root, "home")
const cwd = resolve(root, "workspace")
await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(cwd, { recursive: true })])
const options = {
  binaryPath: process.env.CODEX_BIN || "codex",
  codexHome,
  cwd,
  runtimeScope: "history-probe",
  capabilities: { experimentalApi: true, requestAttestation: false },
}
const first = await CodexRuntime.connect({ ...options, generation: 1 })
const legacy = await first.startThread({ cwd, historyMode: "legacy" })
const paginated = await first.startThread({ cwd, historyMode: "paginated" })
const initial = {
  legacyReadWithTurns: await result(() => first.readThread(legacy.thread.id, true)),
  paginatedReadWithTurns: await result(() => first.readThread(paginated.thread.id, true)),
  paginatedTurnsList: await result(() =>
    first.client.request("thread/turns/list", { threadId: paginated.thread.id, itemsView: "full" }),
  ),
  paginatedItemsList: await result(() => first.client.request("thread/items/list", { threadId: paginated.thread.id })),
}
await first.close()

const second = await CodexRuntime.connect({ ...options, generation: 2 })
const resumed = {
  legacyDefault: await result(() => second.resumeThread(legacy.thread.id)),
  paginatedDefault: await result(() => second.resumeThread(paginated.thread.id)),
  paginatedMetadataOnly: await result(() => second.resumeThread(paginated.thread.id, { excludeTurns: true })),
}
await second.close()
console.log(JSON.stringify({ root, legacyThreadID: legacy.thread.id, paginatedThreadID: paginated.thread.id, initial, resumed }, null, 2))

async function result(run: () => Promise<unknown>) {
  try {
    const value = await run()
    const response = record(value)
    const thread = record(response.thread)
    const turns = thread.turns
    const data = response.data
    return {
      ok: true,
      threadHistoryMode: thread.historyMode,
      turnCount: Array.isArray(turns) ? turns.length : undefined,
      dataCount: Array.isArray(data) ? data.length : undefined,
    }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof CodexRpcError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
