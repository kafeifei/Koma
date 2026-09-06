import { createInterface } from "node:readline"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { v2 } from "../../src/protocol/generated/index"

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.153.4\n")
  process.exit(0)
}
const home = process.env.CODEX_HOME!
const configPath = path.join(home, "fixture.json")
type Config = {
  thread: v2.Thread
  threads?: Record<string, v2.Thread>
  authenticated?: boolean
  disconnectTurn?: boolean
  readError?: boolean
  resumeEvents?: Array<{ method: string; params: unknown }>
  afterReadThread?: v2.Thread
  readEvents?: Array<{ method: string; params: unknown }>
}
const read = () => JSON.parse(readFileSync(configPath, "utf8")) as Config
const save = (value: Config) => writeFileSync(configPath, JSON.stringify(value))
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const settings = (thread: v2.Thread) => ({
  thread,
  model: "native-model",
  reasoningEffort: "low",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "readOnly", networkAccess: false },
  cwd: thread.cwd,
})
let command = ""
setInterval(() => {
  const file = path.join(home, "command.json")
  if (!existsSync(file)) return
  const next = readFileSync(file, "utf8")
  if (!next || next === command) return
  command = next
  const value = JSON.parse(next) as { messages?: unknown[]; exit?: boolean }
  value.messages?.forEach(send)
  if (value.exit) process.exit(17)
}, 5)
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown> }
  appendFileSync(path.join(home, "rpc.jsonl"), `${line}\n`)
  if (!message.method || message.method === "initialized") return
  const reply = (result: unknown) => send({ id: message.id, result })
  if (message.method === "initialize")
    return reply({ userAgent: "host-fixture", codexHome: home, platformFamily: "unix", platformOs: "fixture" })
  if (message.method === "account/read")
    return reply({ account: read().authenticated === false ? null : { type: "apiKey" }, requiresOpenaiAuth: true })
  if (message.method === "model/list")
    return reply({
      data: [
        {
          model: "native-model",
          displayName: "Fixture",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          defaultReasoningEffort: "low",
        },
      ],
      nextCursor: null,
    })
  if (message.method === "account/login/start")
    return reply({ type: "chatgpt", loginId: "login-1", authUrl: "https://example.invalid/login" })
  if (message.method === "account/login/cancel") return reply({ status: "canceled" })
  const config = read()
  if (typeof message.params?.threadId === "string" && config.threads?.[message.params.threadId])
    config.thread = config.threads[message.params.threadId]!
  if (message.method === "thread/start") {
    config.thread.cwd = String(message.params?.cwd)
    save(config)
    return reply(settings(config.thread))
  }
  if (message.method === "thread/resume") {
    config.resumeEvents?.forEach(send)
    config.resumeEvents = undefined
    save(config)
    return reply(settings({ ...config.thread, turns: [] }))
  }
  if (message.method === "thread/read") {
    if (message.params?.includeTurns) {
      if (config.readError)
        return send({ id: message.id, error: { code: -32600, message: "History requires rollout fallback" } })
      const events = config.readEvents
      const snapshot = config.thread
      config.thread = config.afterReadThread ?? config.thread
      config.afterReadThread = undefined
      config.readEvents = undefined
      save(config)
      events?.forEach(send)
      reply({ thread: snapshot })
      if (events) setTimeout(() => events.forEach(send), 10)
      return
    }
    return reply({ thread: { ...config.thread, turns: [] } })
  }
  if (message.method === "turn/start") {
    const turn: v2.Turn = {
      id: `turn-${config.thread.turns.length + 1}`,
      items: [
        {
          type: "userMessage",
          id: "user-1",
          clientId: String(message.params?.clientUserMessageId),
          content: [{ type: "text", text: "saved input", text_elements: [] }],
        },
      ],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    }
    config.thread.turns.push(turn)
    config.thread.status = { type: "active", activeFlags: [] }
    save(config)
    if (config.disconnectTurn) process.exit(17)
    send({ method: "turn/started", params: { threadId: config.thread.id, turn } })
    return reply({ turn })
  }
  if (message.method === "turn/steer") return reply({ turnId: config.thread.turns.at(-1)?.id })
  if (message.method === "turn/interrupt") return reply({})
  send({ id: message.id, error: { code: -32601, message: "Fixture does not support this method" } })
})
