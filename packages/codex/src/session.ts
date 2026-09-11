import type { Thread } from "./protocol/generated/v2/Thread.js"
import type { ThreadQueueAddResponse } from "./protocol/generated/v2/ThreadQueueAddResponse.js"
import type { ThreadQueueDeleteResponse } from "./protocol/generated/v2/ThreadQueueDeleteResponse.js"
import type { ThreadQueueListResponse } from "./protocol/generated/v2/ThreadQueueListResponse.js"
import type { ThreadQueueStartResponse } from "./protocol/generated/v2/ThreadQueueStartResponse.js"
import type { ThreadReadResponse } from "./protocol/generated/v2/ThreadReadResponse.js"
import type { ThreadDeleteResponse } from "./protocol/generated/v2/ThreadDeleteResponse.js"
import type { ThreadResumeParams } from "./protocol/generated/v2/ThreadResumeParams.js"
import type { ThreadResumeResponse } from "./protocol/generated/v2/ThreadResumeResponse.js"
import type { ThreadStartParams } from "./protocol/generated/v2/ThreadStartParams.js"
import type { ThreadStartResponse } from "./protocol/generated/v2/ThreadStartResponse.js"
import type { TurnInterruptResponse } from "./protocol/generated/v2/TurnInterruptResponse.js"
import type { TurnStartParams } from "./protocol/generated/v2/TurnStartParams.js"
import type { TurnStartResponse } from "./protocol/generated/v2/TurnStartResponse.js"
import type { TurnSteerParams } from "./protocol/generated/v2/TurnSteerParams.js"
import type { TurnSteerResponse } from "./protocol/generated/v2/TurnSteerResponse.js"
import type { UserInput } from "./protocol/generated/v2/UserInput.js"
import { projectNotification, projectThread } from "./projection.js"
import type { CodexProjectionOptions, CodexProjectionUpdate, CodexThreadSnapshot } from "./projection.js"
import { connectCodexAppServer } from "./transport.js"
import type {
  CodexAppServerConnection,
  CodexAppServerOptions,
  CodexRequestOptions,
  CodexServerNotification,
} from "./transport.js"

export type CodexRuntimeOptions = Omit<CodexAppServerOptions, "generation"> & {
  runtimeScope: string
}

export class CodexRuntime {
  private constructor(
    readonly runtimeScope: string,
    readonly connection: CodexAppServerConnection,
    private readonly cwd: string,
  ) {}

  static async connect(options: CodexRuntimeOptions & { generation: number }) {
    const connection = await connectCodexAppServer(options)
    return new CodexRuntime(options.runtimeScope, connection, options.cwd)
  }

  get generation() {
    return this.connection.generation
  }

  get client() {
    return this.connection.client
  }

  onNativeNotification(listener: (notification: CodexServerNotification) => void) {
    return this.client.onNotification(listener)
  }

  onProjectionUpdate(listener: (update: CodexProjectionUpdate) => void) {
    return this.onNativeNotification((notification) => {
      listener(projectNotification(notification, this.runtimeScope))
    })
  }

  startThread(params: ThreadStartParams = {}, options?: CodexRequestOptions) {
    return this.client.request<"thread/start", ThreadStartResponse>(
      "thread/start",
      { ...params, cwd: params.cwd ?? this.cwd },
      options,
    )
  }

  readThread(threadID: string, includeTurns = true, options?: CodexRequestOptions) {
    return this.client.request<"thread/read", ThreadReadResponse>(
      "thread/read",
      { threadId: threadID, includeTurns },
      options,
    )
  }

  deleteThread(threadID: string, options?: CodexRequestOptions) {
    return this.client.request<"thread/delete", ThreadDeleteResponse>("thread/delete", { threadId: threadID }, options)
  }

  resumeThread(threadID: string, params: Omit<ThreadResumeParams, "threadId"> = {}, options?: CodexRequestOptions) {
    return this.client.request<"thread/resume", ThreadResumeResponse>(
      "thread/resume",
      { ...params, threadId: threadID },
      options,
    )
  }

  startTurn(params: TurnStartParams, options?: CodexRequestOptions) {
    return this.client.request<"turn/start", TurnStartResponse>("turn/start", params, options)
  }

  steerTurn(params: TurnSteerParams, options?: CodexRequestOptions) {
    return this.client.request<"turn/steer", TurnSteerResponse>("turn/steer", params, options)
  }

  interruptTurn(threadID: string, turnID: string, options?: CodexRequestOptions) {
    return this.client.request<"turn/interrupt", TurnInterruptResponse>(
      "turn/interrupt",
      { threadId: threadID, turnId: turnID },
      options,
    )
  }

  addQueuedSubmission(
    threadID: string,
    input: UserInput[],
    clientUserMessageID: string,
    options?: CodexRequestOptions,
  ) {
    return this.client.request<"thread/queue/add", ThreadQueueAddResponse>(
      "thread/queue/add",
      { threadId: threadID, input, clientUserMessageId: clientUserMessageID },
      options,
    )
  }

  listQueuedSubmissions(threadID: string, options?: CodexRequestOptions) {
    return this.client.request<"thread/queue/list", ThreadQueueListResponse>(
      "thread/queue/list",
      { threadId: threadID },
      options,
    )
  }

  removeQueuedSubmission(threadID: string, queuedSubmissionID: string, options?: CodexRequestOptions) {
    return this.client.request<"thread/queue/delete", ThreadQueueDeleteResponse>(
      "thread/queue/delete",
      { threadId: threadID, queuedSubmissionId: queuedSubmissionID },
      options,
    )
  }

  startQueuedSubmission(threadID: string, queuedSubmissionID?: string, options?: CodexRequestOptions) {
    return this.client.request<"thread/queue/start", ThreadQueueStartResponse>(
      "thread/queue/start",
      { threadId: threadID, queuedSubmissionId: queuedSubmissionID },
      options,
    )
  }

  project(thread: Thread, options: Omit<CodexProjectionOptions, "runtimeScope">): CodexThreadSnapshot {
    return projectThread(thread, { ...options, runtimeScope: this.runtimeScope })
  }

  close() {
    return this.client.close()
  }
}

export class CodexRuntimeManager {
  private generation = 0
  private runtime: CodexRuntime | undefined
  private pending: Promise<CodexRuntime> | undefined

  constructor(private readonly options: CodexRuntimeOptions) {}

  get() {
    if (this.runtime && !this.runtime.client.closed) return Promise.resolve(this.runtime)
    if (this.pending) return this.pending
    const generation = ++this.generation
    const pending = CodexRuntime.connect({ ...this.options, generation })
      .then(async (runtime) => {
        if (this.generation !== generation) {
          await runtime.close()
          throw new Error(`Discarded stale Codex runtime generation ${generation}`)
        }
        this.runtime = runtime
        runtime.client.onExit(() => {
          if (this.runtime?.generation === generation) this.runtime = undefined
        })
        return runtime
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
    this.pending = pending
    return pending
  }

  async reconnect() {
    this.generation++
    const runtime = this.runtime
    const pending = this.pending
    this.runtime = undefined
    this.pending = undefined
    if (runtime) await runtime.close()
    if (pending)
      await pending.then(
        (connecting) => connecting.close(),
        () => undefined,
      )
    return this.get()
  }

  async close() {
    this.generation++
    const runtime = this.runtime
    const pending = this.pending
    this.runtime = undefined
    this.pending = undefined
    if (runtime) await runtime.close()
    if (pending)
      await pending.then(
        (connecting) => connecting.close(),
        () => undefined,
      )
  }
}
