import { createInterface } from "node:readline"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { v2 } from "../../src/protocol/generated/index"

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.154.0\n")
  process.exit(0)
}
const home = process.env.CODEX_HOME!
appendFileSync(path.join(home, "starts.jsonl"), `${JSON.stringify(process.argv.slice(2))}\n`)
const configPath = path.join(home, "fixture.json")
type Config = {
  thread: v2.Thread
  threads?: Record<string, v2.Thread>
  authenticated?: boolean
  refreshOnLogin?: boolean
  delayLogin?: boolean
  steerItemBeforeAck?: boolean
  disconnectTurn?: boolean
  readError?: boolean
  readDelayMs?: number
  resumeDelayMs?: number
  resumeError?: { code: number; message: string }
  turnStartDelayMs?: number
  resumeEvents?: Array<{ method: string; params: unknown }>
  afterResumeThread?: v2.Thread
  afterReadThread?: v2.Thread
  readEvents?: Array<{ method: string; params: unknown }>
  nativeSettings?: Pick<v2.ThreadStartResponse, "sandbox" | "approvalPolicy" | "approvalsReviewer">
  reflectProvider?: boolean
  selectedModel?: string
  selectedProvider?: string
  reflectSettings?: boolean
  turnRequests?: Array<{ id: string; method: string; params: Record<string, unknown> }>
  waitForApprovals?: boolean
  deletedThreads?: string[]
  deleteDisconnectOnce?: boolean
  deleteError?: { code: number; message: string }
}
const read = () => JSON.parse(readFileSync(configPath, "utf8")) as Config
const save = (value: Config) => writeFileSync(configPath, JSON.stringify(value))
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const settings = (thread: v2.Thread) => ({
  thread,
  model: read().selectedModel ?? "native-model",
  modelProvider: read().selectedProvider ?? "openai",
  reasoningEffort: "low",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "readOnly", networkAccess: false },
  cwd: thread.cwd,
  ...read().nativeSettings,
})
const waiting = new Map<string | number, () => void>()
let command = ""
setInterval(() => {
  const file = path.join(home, "command.json")
  if (!existsSync(file)) return
  const next = readFileSync(file, "utf8")
  if (!next || next === command) return
  command = next
  const value = JSON.parse(next) as { messages?: unknown[]; patch?: Partial<Config>; exit?: boolean }
  if (value.patch) save({ ...read(), ...value.patch })
  value.messages?.forEach(send)
  if (value.exit) process.exit(17)
}, 5)
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown> }
  appendFileSync(path.join(home, "rpc.jsonl"), `${line}\n`)
  if (!message.method) {
    if (message.id !== undefined) {
      waiting.get(message.id)?.()
      waiting.delete(message.id)
    }
    return
  }
  if (message.method === "initialized") return
  const reply = (result: unknown) => send({ id: message.id, result })
  if (message.method === "initialize")
    return reply({ userAgent: "host-fixture", codexHome: home, platformFamily: "unix", platformOs: "fixture" })
  if (message.method === "account/read")
    return reply({ account: read().authenticated === false ? null : { type: "apiKey" }, requiresOpenaiAuth: true })
  if (message.method === "model/list")
    return reply({
      data: [
        {
          model: read().selectedModel ?? "native-model",
          modelProvider: read().selectedProvider ?? "openai",
          displayName: "Fixture",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          defaultReasoningEffort: "low",
        },
      ],
      nextCursor: null,
    })
  if (message.method === "account/login/start" && message.params?.type === "chatgptAuthTokens") {
    const config = read()
    config.authenticated = true
    save(config)
    send({ method: "account/updated", params: { authMode: "chatgptAuthTokens", planType: null } })
    if (config.refreshOnLogin)
      send({
        id: "login-refresh",
        method: "account/chatgptAuthTokens/refresh",
        params: {
          reason: "unauthorized",
          previousAccountId: message.params.chatgptAccountId,
        },
      })
    if (config.delayLogin) return setTimeout(() => reply({ type: "chatgptAuthTokens" }), 100)
    return reply({ type: "chatgptAuthTokens" })
  }
  if (message.method === "account/logout") {
    save({ ...read(), authenticated: false })
    return reply({})
  }
  if (message.method === "account/login/start")
    return reply({ type: "chatgpt", loginId: "login-1", authUrl: "https://example.invalid/login" })
  if (message.method === "account/login/cancel") return reply({ status: "canceled" })
  const config = read()
  if (
    typeof message.params?.threadId === "string" &&
    config.deletedThreads?.includes(message.params.threadId) &&
    message.method === "thread/read"
  )
    return send({
      id: message.id,
      error: { code: -32600, message: `no rollout found for thread id ${message.params.threadId}` },
    })
  if (typeof message.params?.threadId === "string" && config.threads?.[message.params.threadId])
    config.thread = config.threads[message.params.threadId]!
  if (message.method === "thread/start") {
    config.thread.cwd = String(message.params?.cwd)
    if (config.reflectProvider) {
      config.selectedModel = String(message.params?.model ?? "native-model")
      config.selectedProvider = String(message.params?.modelProvider ?? "openai")
      config.thread.modelProvider = config.selectedProvider
    }
    if (config.reflectSettings && message.params?.sandbox)
      config.nativeSettings = {
        approvalPolicy: message.params.approvalPolicy as v2.AskForApproval,
        approvalsReviewer: message.params.approvalsReviewer as v2.ApprovalsReviewer,
        sandbox:
          message.params.sandbox === "danger-full-access"
            ? { type: "dangerFullAccess" }
            : message.params.sandbox === "read-only"
              ? { type: "readOnly", networkAccess: false }
              : {
                  type: "workspaceWrite",
                  writableRoots: [],
                  networkAccess: false,
                  excludeTmpdirEnvVar: false,
                  excludeSlashTmp: false,
                },
      }
    save(config)
    return reply(settings(config.thread))
  }
  if (message.method === "thread/list") return reply({ data: [], nextCursor: null })
  if (message.method === "thread/archive") return reply({})
  if (message.method === "thread/unarchive") return reply({ thread: config.thread })
  if (message.method === "thread/unsubscribe") return reply({ status: "unsubscribed" })
  if (message.method === "thread/delete") {
    const threadID = String(message.params?.threadId)
    if (config.deleteError) return send({ id: message.id, error: config.deleteError })
    config.deletedThreads = [...new Set([...(config.deletedThreads ?? []), threadID])]
    const disconnect = config.deleteDisconnectOnce
    config.deleteDisconnectOnce = false
    save(config)
    send({ method: "thread/deleted", params: { threadId: threadID } })
    send({ method: "thread/status/changed", params: { threadId: threadID, status: { type: "notLoaded" } } })
    if (disconnect) return process.exit(17)
    return reply({})
  }
  if (message.method === "thread/resume") {
    if (config.resumeError) return send({ id: message.id, error: config.resumeError })
    if (config.reflectProvider) {
      config.selectedModel = String(message.params?.model ?? config.selectedModel ?? "native-model")
      config.selectedProvider = String(message.params?.modelProvider ?? config.selectedProvider ?? "openai")
    }
    config.resumeEvents?.forEach(send)
    config.resumeEvents = undefined
    save(config)
    const response = settings({ ...config.thread, turns: [] })
    const afterResume = config.afterResumeThread
    if (afterResume && afterResume.id === message.params?.threadId) {
      config.thread = afterResume
      if (config.threads?.[config.thread.id]) config.threads[config.thread.id] = config.thread
      config.afterResumeThread = undefined
      save(config)
    }
    if (config.resumeDelayMs) return setTimeout(() => reply(response), config.resumeDelayMs)
    return reply(response)
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
      if (config.readDelayMs) setTimeout(() => reply({ thread: snapshot }), config.readDelayMs)
      else reply({ thread: snapshot })
      if (events) setTimeout(() => events.forEach(send), 10)
      return
    }
    const response = { thread: { ...config.thread, turns: [] } }
    if (config.readDelayMs) return setTimeout(() => reply(response), config.readDelayMs)
    return reply(response)
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
    if (config.reflectProvider) config.selectedModel = String(message.params?.model ?? config.selectedModel)
    config.thread.turns.push(turn)
    config.thread.status = { type: "active", activeFlags: [] }
    if (config.reflectSettings && message.params?.sandboxPolicy) {
      const sandbox = message.params.sandboxPolicy as v2.SandboxPolicy
      config.nativeSettings = {
        approvalPolicy: message.params.approvalPolicy as v2.AskForApproval,
        approvalsReviewer: message.params.approvalsReviewer as v2.ApprovalsReviewer,
        sandbox:
          sandbox.type === "workspaceWrite"
            ? {
                ...sandbox,
                writableRoots: sandbox.writableRoots.filter((root) => root !== config.thread.cwd),
              }
            : sandbox,
      }
    }
    save(config)
    if (config.disconnectTurn) process.exit(17)
    send({ method: "turn/started", params: { threadId: config.thread.id, turn } })
    if (config.reflectSettings)
      send({
        method: "thread/settings/updated",
        params: {
          threadId: config.thread.id,
          threadSettings: { ...settings(config.thread), sandboxPolicy: settings(config.thread).sandbox, effort: "low" },
        },
      })
    const pending = new Set(config.turnRequests?.map((request) => request.id))
    config.turnRequests?.forEach((request) => {
      if (config.waitForApprovals)
        waiting.set(request.id, () => {
          pending.delete(request.id)
          if (!pending.size) reply({ turn })
        })
      send({
        ...request,
        params: { threadId: config.thread.id, turnId: turn.id, itemId: request.id, ...request.params },
      })
    })
    if (config.waitForApprovals && pending.size) return
    if (config.turnStartDelayMs) return setTimeout(() => reply({ turn }), config.turnStartDelayMs)
    return reply({ turn })
  }
  if (message.method === "turn/steer") {
    const turn = config.thread.turns.at(-1)!
    if (config.steerItemBeforeAck) {
      const item: v2.ThreadItem = {
        type: "userMessage",
        id: `steer-${String(message.params?.clientUserMessageId)}`,
        clientId: String(message.params?.clientUserMessageId),
        content: [{ type: "text", text: "saved steer", text_elements: [] }],
      }
      turn.items.push(item)
      save(config)
      send({ method: "item/started", params: { threadId: config.thread.id, turnId: turn.id, item } })
      send({ method: "item/completed", params: { threadId: config.thread.id, turnId: turn.id, item } })
    }
    return reply({ turnId: turn.id })
  }
  if (message.method === "turn/interrupt") return reply({})
  send({ id: message.id, error: { code: -32601, message: "Fixture does not support this method" } })
})
