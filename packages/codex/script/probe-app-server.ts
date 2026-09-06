import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CodexRuntime } from "../src/session.js"
import { CodexRpcError } from "../src/transport.js"

const root = resolve(".cache", `app-server-${Date.now()}-${process.pid}`)
const codexHome = resolve(root, "home")
const cwd = resolve(root, "workspace")
const binaryPath = process.env.CODEX_BIN || "codex"
await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(cwd, { recursive: true })])
await writeFile(resolve(cwd, "README.md"), "isolated Codex app-server probe\n")

const diagnostics: string[] = []
const first = await CodexRuntime.connect({
  binaryPath,
  codexHome,
  cwd,
  generation: 1,
  runtimeScope: "probe",
  capabilities: { experimentalApi: true, requestAttestation: false },
  onDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.stream}: ${diagnostic.message}`),
})
assert(first.connection.initialize.codexHome === codexHome, "app-server used a different Codex home")
const started = await first.startThread({ cwd, historyMode: "paginated" })
const threadID = started.thread.id
const historyReadError = await first.readThread(threadID).then(
  () => null,
  (error) => {
    if (!(error instanceof CodexRpcError)) throw error
    return { code: error.code, message: error.message }
  },
)
const read = await first.readThread(threadID, false)
assert(read.thread.id === threadID, "thread/read returned a different thread")
await first.close()

const second = await CodexRuntime.connect({
  binaryPath,
  codexHome,
  cwd,
  generation: 2,
  runtimeScope: "probe",
  capabilities: { experimentalApi: true, requestAttestation: false },
  onDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.stream}: ${diagnostic.message}`),
})
const readAfterStop = await second.readThread(threadID, false)
assert(readAfterStop.thread.id === threadID, "thread was not readable after app-server stop")
const resumed = await second.resumeThread(threadID, { excludeTurns: true })
assert(resumed.thread.id === threadID, "thread/resume returned a different thread")
await second.close()

const report = {
  binaryPath,
  codexVersion: first.connection.version,
  codexHome,
  cwd,
  threadID,
  initialize: first.connection.initialize,
  threadStart: true,
  threadRead: true,
  historyHydrationRead: historyReadError ? { supported: false, error: historyReadError } : { supported: true },
  threadResume: true,
  queueProbe: "skipped: idle queue/add was separately observed to start a turn immediately",
  modelTurnStarted: false,
  loginStarted: false,
  diagnostics,
}
await writeFile(resolve(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
