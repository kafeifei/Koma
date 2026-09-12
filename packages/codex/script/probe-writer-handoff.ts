import { strict as assert } from "node:assert"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CodexRuntime } from "../src/session"
import { unloadWriter } from "../src/writer-unload"
import { writerHandoff, isWriterConflict } from "../src/writer-handoff"

const root = resolve(".cache", `writer-handoff-${Date.now()}-${process.pid}`)
const home = resolve(root, "home"),
  cwd = resolve(root, "workspace")
await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true })])
let requested = false
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    requested = true
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"probe","status":"in_progress","output":[]}}\n\n',
            ),
          )
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  },
})
const options = {
  binaryPath: process.env.CODEX_BIN ?? "/Users/kafeifei/.local/bin/codex",
  codexHome: home,
  cwd,
  runtimeScope: "handoff-probe",
  capabilities: { experimentalApi: true, requestAttestation: false },
}
const first = await CodexRuntime.connect({ ...options, generation: 1 })
const second = await CodexRuntime.connect({ ...options, generation: 2 })
let owner: Awaited<ReturnType<typeof writerHandoff>> | undefined
let peer: Awaited<ReturnType<typeof writerHandoff>> | undefined
const steps: string[] = []
try {
  const settings = {
    cwd,
    historyMode: "paginated" as const,
    model: "gpt-5.4",
    modelProvider: "probe",
    approvalPolicy: "never" as const,
    config: {
      model_providers: {
        probe: {
          name: "Probe",
          base_url: `http://127.0.0.1:${model.port}/v1`,
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: false,
        },
      },
    },
  }
  const started = await first.startThread(settings)
  const id = started.thread.id
  let completed = false
  first.onNativeNotification((event) => {
    if (event.method === "turn/completed") {
      completed = true
      steps.push("native turn completed")
    }
  })
  const turn = await first.startTurn({
    threadId: id,
    input: [{ type: "text", text: "Hold this isolated handoff probe", text_elements: [] }],
  })
  await until(() => requested)
  steps.push("first native process running")
  await assert.rejects(second.resumeThread(id, { excludeTurns: true, ...settings }), isWriterConflict)
  steps.push("second native process rejected by actual writer lock")
  owner = await writerHandoff({
    home,
    owns: (threadID) => threadID === id,
    release: async () => {
      await first.interruptTurn(id, turn.turn.id)
      steps.push("interrupt acknowledged")
      await until(() => completed)
      await unloadWriter(first, home, id)
      steps.push("native writer unloaded and original archive state restored")
    },
  })
  peer = await writerHandoff({ home, owns: () => false, release: async () => {} })
  assert.equal(await peer.release(id), true)
  const releaseStarted = Date.now()
  let resumed
  while (!resumed) {
    try {
      resumed = await second.resumeThread(id, { excludeTurns: true, ...settings })
    } catch (error) {
      if (!isWriterConflict(error) || Date.now() - releaseStarted > 10_000) {
        console.log(JSON.stringify({ steps, waited: Date.now() - releaseStarted }))
        throw error
      }
      await Bun.sleep(100)
    }
  }
  steps.push(`writer lock released after ${Date.now() - releaseStarted} ms`)
  assert.equal(resumed.thread.id, id)
  const history = await second.readThread(id, true)
  assert.equal(history.thread.turns.length, 1)
  assert.equal(history.thread.turns[0]?.status, "interrupted")
  assert.equal(first.client.closed, false)
  steps.push("same native thread and interrupted history resumed; original process remains running")
  const report = { root, nativeVersion: first.connection.version, threadID: id, steps, passed: true }
  await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await peer?.close()
  await owner?.close()
  await second.close()
  await first.close()
  model.stop(true)
}
async function until(ready: () => boolean) {
  const deadline = Date.now() + 15_000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("Native handoff probe timed out")
    await Bun.sleep(20)
  }
}
