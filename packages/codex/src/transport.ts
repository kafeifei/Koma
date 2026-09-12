import { execFile, spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { createInterface } from "node:readline"
import type { ClientNotification } from "./protocol/generated/ClientNotification.js"
import type { ClientRequest } from "./protocol/generated/ClientRequest.js"
import type { InitializeParams } from "./protocol/generated/InitializeParams.js"
import type { InitializeResponse } from "./protocol/generated/InitializeResponse.js"

export const CODEX_APP_SERVER_VERSION = "0.153.4"

type MethodOf<T> = T extends { method: infer Method extends string } ? Method : never
type RequestFor<Method extends ClientRequestMethod> = Extract<ClientRequest, { method: Method }>
type NotificationFor<Method extends ClientNotificationMethod> = Extract<ClientNotification, { method: Method }>

export type ClientRequestMethod = MethodOf<ClientRequest>
export type ClientNotificationMethod = MethodOf<ClientNotification>
export type ClientRequestParams<Method extends ClientRequestMethod> =
  RequestFor<Method> extends {
    params: infer Params
  }
    ? Params
    : RequestFor<Method> extends { params?: infer Params }
      ? Params | undefined
      : undefined
export type ClientNotificationParams<Method extends ClientNotificationMethod> =
  NotificationFor<Method> extends {
    params: infer Params
  }
    ? Params
    : NotificationFor<Method> extends { params?: infer Params }
      ? Params | undefined
      : undefined

export type JsonRpcID = string | number

export type JsonRpcErrorPayload = {
  code: number
  message: string
  data?: unknown
}

export type CodexServerRequest = {
  generation: number
  id: JsonRpcID
  method: string
  params: unknown
}

export type CodexServerNotification = {
  generation: number
  method: string
  params: unknown
}

export type CodexServerRequestResult =
  | { result: unknown; error?: undefined }
  | { result?: undefined; error: JsonRpcErrorPayload }

export type CodexServerRequestHandler = (
  request: CodexServerRequest,
) => CodexServerRequestResult | Promise<CodexServerRequestResult>

export type CodexTransportExit = {
  generation: number
  code: number | null
  signal: NodeJS.Signals | null
  expected: boolean
}

export type CodexTransportDiagnostic = {
  generation: number
  stream: "stderr" | "transport"
  message: string
}

export type CodexRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

export type CodexAppServerOptions = {
  binaryPath: string
  codexHome: string
  codexSqliteHome?: string
  cwd: string
  generation: number
  clientInfo?: InitializeParams["clientInfo"]
  capabilities?: InitializeParams["capabilities"]
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  requestHandler?: CodexServerRequestHandler
  onDiagnostic?: (diagnostic: CodexTransportDiagnostic) => void
}

export type CodexAppServerConnection = {
  version: typeof CODEX_APP_SERVER_VERSION
  generation: number
  initialize: InitializeResponse
  client: CodexStdioTransport
}

type WireRequest = {
  id: JsonRpcID
  method: string
  params?: unknown
}

type WireNotification = {
  method: string
  params?: unknown
}

type WireSuccess = {
  id: JsonRpcID
  result: unknown
}

type WireFailure = {
  id: JsonRpcID
  error: JsonRpcErrorPayload
}

type PendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  cleanup: () => void
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = "CodexRpcError"
  }
}

export class CodexTransportClosedError extends Error {
  constructor(
    readonly generation: number,
    message: string,
  ) {
    super(message)
    this.name = "CodexTransportClosedError"
  }
}

export class CodexVersionMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly binaryPath: string,
  ) {
    super(`Unsupported Codex binary ${actual}; expected ${expected}: ${binaryPath}`)
    this.name = "CodexVersionMismatchError"
  }
}

export class CodexStdioTransport {
  private nextID = 1
  private state: "open" | "closing" | "closed" = "open"
  private exitResult: CodexTransportExit | undefined
  private readonly pending = new Map<JsonRpcID, PendingRequest>()
  private readonly notificationListeners = new Set<(notification: CodexServerNotification) => void>()
  private readonly exitListeners = new Set<(exit: CodexTransportExit) => void>()
  private readonly exitPromise: Promise<CodexTransportExit>
  private resolveExit!: (exit: CodexTransportExit) => void

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    readonly generation: number,
    private requestHandler?: CodexServerRequestHandler,
    private readonly onDiagnostic?: (diagnostic: CodexTransportDiagnostic) => void,
  ) {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    const stdout = createInterface({ input: process.stdout, crlfDelay: Infinity })
    const stderr = createInterface({ input: process.stderr, crlfDelay: Infinity })
    stdout.on("line", (line) => this.receive(line))
    stderr.on("line", (message) => this.diagnostic("stderr", message))
    process.stdin.on("error", (error) => this.failTransport(error))
    process.on("error", (error) => this.failTransport(error))
    process.once("exit", (code, signal) => {
      stdout.close()
      stderr.close()
      this.finishExit({ generation, code, signal, expected: this.state === "closing" })
    })
  }

  get closed() {
    return this.state === "closed"
  }

  get pendingRequestCount() {
    return this.pending.size
  }

  setServerRequestHandler(handler: CodexServerRequestHandler | undefined) {
    this.requestHandler = handler
  }

  onNotification(listener: (notification: CodexServerNotification) => void) {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onExit(listener: (exit: CodexTransportExit) => void) {
    if (this.exitResult) {
      listener(this.exitResult)
      return () => false
    }
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  request<Method extends ClientRequestMethod, Result = unknown>(
    method: Method,
    params: ClientRequestParams<Method>,
    options: CodexRequestOptions = {},
  ) {
    if (this.state !== "open") {
      return Promise.reject<Result>(new CodexTransportClosedError(this.generation, "Codex transport is closed"))
    }
    if (options.signal?.aborted) {
      return Promise.reject<Result>(
        options.signal.reason instanceof Error ? options.signal.reason : new Error("Request aborted"),
      )
    }
    const id = this.nextID++
    return new Promise<Result>((resolve, reject) => {
      const timeout = options.timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id)
            cleanup()
            reject(new CodexTransportClosedError(this.generation, `Codex request timed out: ${method}`))
          }, options.timeoutMs)
        : undefined
      timeout?.unref()
      const onAbort = () => {
        this.pending.delete(id)
        cleanup()
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Request aborted"))
      }
      const cleanup = () => {
        if (timeout) clearTimeout(timeout)
        options.signal?.removeEventListener("abort", onAbort)
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        method,
        resolve: (result) => resolve(result as Result),
        reject,
        cleanup,
      })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify<Method extends ClientNotificationMethod>(method: Method, params: ClientNotificationParams<Method>) {
    this.write(params === undefined ? { method } : { method, params })
  }

  async close(graceMs = 2_000) {
    if (this.state === "closed") return this.exitResult
    if (this.state === "open") {
      this.state = "closing"
      this.rejectPending(new CodexTransportClosedError(this.generation, "Codex transport is closing"))
      this.process.stdin.end()
      const force = setTimeout(() => this.process.kill("SIGKILL"), graceMs)
      force.unref()
      await this.exitPromise.finally(() => clearTimeout(force))
    }
    return this.exitPromise
  }

  private receive(line: string) {
    if (!line.trim()) return
    const message = (() => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        this.diagnostic("transport", `Invalid JSON from Codex app-server: ${line.slice(0, 200)}`)
      }
    })()
    if (!isRecord(message)) return
    if (isID(message.id) && typeof message.method !== "string" && ("result" in message || "error" in message)) {
      this.receiveResponse(message as WireSuccess | WireFailure)
      return
    }
    if (typeof message.method !== "string") {
      this.diagnostic("transport", `Unknown Codex message: ${line.slice(0, 200)}`)
      return
    }
    if (isID(message.id)) {
      void this.receiveRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      })
      return
    }
    const notification = {
      generation: this.generation,
      method: message.method,
      params: message.params,
    }
    this.notificationListeners.forEach((listener) => {
      try {
        listener(notification)
      } catch (error) {
        this.diagnostic(
          "transport",
          `Codex notification listener failed for ${message.method}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
  }

  private receiveResponse(message: WireSuccess | WireFailure) {
    const pending = this.pending.get(message.id)
    if (!pending) {
      this.diagnostic("transport", `Ignoring response for unknown request ${String(message.id)}`)
      return
    }
    this.pending.delete(message.id)
    pending.cleanup()
    if ("error" in message) {
      pending.reject(new CodexRpcError(message.error.code, message.error.message, message.error.data))
      return
    }
    pending.resolve(message.result)
  }

  private async receiveRequest(message: WireRequest) {
    if (!this.requestHandler) {
      this.write({
        id: message.id,
        error: { code: -32601, message: `Unhandled Codex server request: ${message.method}` },
      })
      return
    }
    try {
      const response = await this.requestHandler({
        generation: this.generation,
        id: message.id,
        method: message.method,
        params: message.params,
      })
      if (this.state !== "open") return
      this.write(
        response.error
          ? { id: message.id, error: response.error }
          : { id: message.id, result: response.result === undefined ? null : response.result },
      )
    } catch (error) {
      if (this.state !== "open") return
      this.write({
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  private write(message: WireRequest | WireNotification | WireSuccess | WireFailure) {
    if (this.state !== "open") throw new CodexTransportClosedError(this.generation, "Codex transport is closed")
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private failTransport(error: Error) {
    this.diagnostic("transport", error.message)
    this.process.kill()
  }

  private finishExit(exit: CodexTransportExit) {
    if (this.state === "closed") return
    this.state = "closed"
    this.exitResult = exit
    this.rejectPending(
      new CodexTransportClosedError(
        this.generation,
        `Codex app-server exited (code=${String(exit.code)}, signal=${String(exit.signal)})`,
      ),
    )
    this.resolveExit(exit)
    this.exitListeners.forEach((listener) => {
      try {
        listener(exit)
      } catch (error) {
        this.diagnostic(
          "transport",
          `Codex exit listener failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
    this.exitListeners.clear()
  }

  private rejectPending(error: Error) {
    this.pending.forEach((pending) => {
      pending.cleanup()
      pending.reject(error)
    })
    this.pending.clear()
  }

  private diagnostic(stream: CodexTransportDiagnostic["stream"], message: string) {
    try {
      this.onDiagnostic?.({ generation: this.generation, stream, message })
    } catch {
      // Diagnostics must not corrupt the transport that produced them.
    }
  }
}

export async function connectCodexAppServer(options: CodexAppServerOptions): Promise<CodexAppServerConnection> {
  await validateOptions(options)
  const actualVersion = await readCodexVersion(options.binaryPath)
  if (actualVersion !== CODEX_APP_SERVER_VERSION) {
    throw new CodexVersionMismatchError(CODEX_APP_SERVER_VERSION, actualVersion, options.binaryPath)
  }
  const child = spawn(options.binaryPath, ["app-server", "--stdio", ...(options.args ?? [])], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      CODEX_HOME: options.codexHome,
      CODEX_SQLITE_HOME: options.codexSqliteHome ?? options.codexHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const client = new CodexStdioTransport(child, options.generation, options.requestHandler, options.onDiagnostic)
  try {
    const initialize = await client.request<"initialize", InitializeResponse>(
      "initialize",
      {
        clientInfo: options.clientInfo ?? {
          name: "koma",
          title: "Koma",
          version: "1.18.29",
        },
        capabilities: options.capabilities ?? null,
      },
      { timeoutMs: 15_000 },
    )
    client.notify("initialized", undefined)
    return {
      version: CODEX_APP_SERVER_VERSION,
      generation: options.generation,
      initialize,
      client,
    }
  } catch (error) {
    await client.close()
    throw error
  }
}

export function readCodexVersion(binaryPath: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(binaryPath, ["--version"], { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      const match = stdout.match(/\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?/)
      if (!match) {
        reject(new Error(`Could not parse Codex version from ${binaryPath}`))
        return
      }
      resolve(match[0])
    })
  })
}

async function validateOptions(options: CodexAppServerOptions) {
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    throw new Error("Codex transport generation must be a positive integer")
  }
  if (!isAbsolute(options.codexHome)) throw new Error("Codex home must be an absolute path")
  if (!isAbsolute(options.cwd)) throw new Error("Codex cwd must be an absolute path")
  const cwd = await stat(options.cwd)
  if (!cwd.isDirectory()) throw new Error(`Codex cwd is not a directory: ${options.cwd}`)
  const home = await stat(options.codexHome)
  if (!home.isDirectory()) throw new Error(`Codex home is not a directory: ${options.codexHome}`)
  if (options.codexSqliteHome !== undefined) {
    if (!isAbsolute(options.codexSqliteHome)) throw new Error("Codex SQLite home must be an absolute path")
    const sqliteHome = await stat(options.codexSqliteHome)
    if (!sqliteHome.isDirectory()) throw new Error(`Codex SQLite home is not a directory: ${options.codexSqliteHome}`)
  }
}

function isID(value: unknown): value is JsonRpcID {
  return typeof value === "string" || typeof value === "number"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
