export * as CodexHost from "./host"

import { createHash, randomUUID } from "node:crypto"
import { access, mkdir, realpath } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Global } from "@opencode-ai/core/global"
import { KomaInstructions } from "@opencode-ai/core/koma-instructions"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExternal } from "@opencode-ai/core/session/external/index"
import { SessionExternalOwnership } from "@opencode-ai/core/session/external/ownership"
import { KomaBackend } from "@opencode-ai/core/koma-backend"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import {
  Account,
  Capabilities,
  Changed,
  Create,
  Delivery,
  Descriptor,
  Engine,
  EngineChanged,
  Input,
  InputWaitReason,
  Interaction,
  Login,
  Message,
  Plan,
  Reply,
  RuntimeStatus,
  Settings,
  Snapshot,
  Submit,
} from "@opencode-ai/schema/session-external"
import { CodexRuntime, CodexRuntimeManager } from "./session"
import { CODEX_APP_SERVER_VERSION, CodexRpcError } from "./transport"
import type { CodexServerNotification, CodexServerRequest, CodexServerRequestResult } from "./transport"
import type { v2 } from "./protocol/generated/index"
import { projectThread, projectItem } from "./projection"
import { projectCodexView, projectCodexRolloutView } from "./view"
import type { CodexView } from "./view"
import { readCodexRolloutHistory } from "./history"
import { createCodexInteraction } from "./interaction"
import { codexInput, prepareInput, threadSettings, turnSettings } from "./input"
import { CodexWorktreeAccess } from "./worktree-access"
import { CodexProviders } from "./providers"
import { providerCredentials } from "./provider-credentials"
import { codexStorage } from "./storage"
import { snapshotUpdate, toolOutputAppend } from "./snapshot-update"

export class HostError extends Schema.TaggedErrorClass<HostError>()("CodexHost.Error", {
  code: Schema.Literals(["unavailable", "conflict", "notFound", "invalid", "nativeError"]),
  message: Schema.String,
}) {}

type Accepted = { descriptor: Descriptor; delivery: Delivery }
type QueueInput = { action: "resume" | "withdraw"; requestID: string; revision: number }
type Result<A> = Effect.Effect<A, HostError>

export interface Interface {
  readonly engines: () => Result<Engine[]>
  readonly account: () => Result<Account>
  readonly login: () => Result<Login>
  readonly cancelLogin: (loginID: string) => Result<Account>
  readonly describe: (sessionIDs: readonly SessionSchema.ID[]) => Result<Descriptor[]>
  readonly create: (input: Create) => Result<Accepted>
  readonly submit: (sessionID: SessionSchema.ID, input: Submit) => Result<Accepted>
  readonly snapshot: (sessionID: SessionSchema.ID) => Result<Snapshot>
  readonly delivery: (sessionID: SessionSchema.ID, requestID: string) => Result<Delivery>
  readonly queue: (sessionID: SessionSchema.ID, input: QueueInput) => Result<Snapshot>
  readonly interrupt: (sessionID: SessionSchema.ID) => Result<Descriptor>
  readonly reply: (sessionID: SessionSchema.ID, interactionID: string, input: Reply) => Result<Snapshot>
  readonly settings: (sessionID: SessionSchema.ID, input: Settings) => Result<Descriptor>
  readonly remove: (sessionID: SessionSchema.ID) => Result<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodexHost") {}

const disabled: Capabilities = {
  prompt: false,
  steer: false,
  queue: "unavailable",
  compact: false,
  images: false,
  permissions: false,
  delete: false,
}
const supported: Capabilities = {
  prompt: true,
  steer: true,
  queue: "host",
  compact: false,
  images: true,
  permissions: true,
  delete: true,
}
const blocked: Capabilities = { ...disabled, delete: true }
const decodeInput = Schema.decodeUnknownSync(Input)
const decodeSettings = (value: unknown): Settings => {
  const settings = Schema.decodeUnknownSync(Settings)(value)
  return settings.permission === "workspace" ? { ...settings, permission: "default" } : settings
}
const json = (value: unknown) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(value))

type PendingInteraction = {
  view: Interaction
  generation: number
  blocking: boolean
  resolve: (value: CodexServerRequestResult) => void
  reply: NonNullable<Awaited<ReturnType<typeof createCodexInteraction>>>["reply"]
}

type Received = CodexServerNotification & { sequence: number }
type MutableView = CodexView & { messages: Message[] }

type Entry = {
  record: SessionExternal.Record
  status: RuntimeStatus
  revision: number
  native?: v2.Thread
  autoTitle?: string
  plan?: Plan
  view: MutableView
  fallback?: { view: CodexView; turns: Set<string> }
  items: Map<string, { turn: v2.Turn; item: v2.ThreadItem }>
  messageIndices: Map<string, number>
  blockedDeltas: Set<string>
  coveredSequence: number
  dirty: boolean
  refreshTimer?: ReturnType<typeof setTimeout>
  refreshPending: boolean
  refreshing?: Promise<void>
  activating?: Promise<void>
  deletionChecks: number
  idleConfirmed: boolean
  appliedSettings: Settings
  nativeProvider?: string
  providerConfig?: string
  globalInstructions?: string
  // Execution/history reads may complete after a settings write. Keep the
  // confirmed durable intent in the interaction lane instead of those snapshots.
  desiredSettings: Settings
  settingsSequence: number
  activeTools: Map<string, { turnID: string; generation: number }>
  executionObserved: boolean
  activeTurnID?: string
  generation?: number
  resumed: boolean
  observedOnly: boolean
  lease: boolean
  leaseTarget?: { directory: string; sessionID: SessionSchema.ID }
  error?: string
  inputWaitReason?: InputWaitReason
  controlSequence: number
  operations: Promise<void>
  interactions: Promise<void>
  leases: Promise<void>
  pending: Map<string, PendingInteraction>
  diffs: Record<string, { status: "available"; value: string }>
  itemTimes: Record<string, { created?: number; completed?: number; ran?: number }>
  usage?: v2.ThreadTokenUsage
  published?: Snapshot
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionExternal.Service
    const ownership = yield* SessionExternalOwnership.Service
    const worktrees = yield* CodexWorktreeAccess.Service
    const providers = yield* CodexProviders.Service
    const credentials = providerCredentials(providers)
    const events = yield* EventV2.Service
    const global = yield* Global.Service
    const instructions = yield* KomaInstructions.Service
    const enabled = process.env.OPENCODE_ENABLE_CODEX === "1"
    const storage = codexStorage({
      state: global.state,
      root: process.env.OPENCODE_HOME,
      home: process.env.OPENCODE_CODEX_HOME,
    })
    const home = storage.home
    const runtimeScope = storage.scope
    const epoch = randomUUID()
    const entries = new Map<SessionSchema.ID, Entry>()
    const nativeSessions = new Map<string, SessionSchema.ID>()
    const buffered = new Map<string, Received[]>()
    const resolving = new Map<string, Promise<Entry | undefined>>()
    const signals = new Map<string, number>()
    const resolvedRequests = new Set<string>()
    let receiveSequence = 0
    const state: {
      manager?: CodexRuntimeManager
      runtime?: CodexRuntime
      connecting?: Promise<CodexRuntime>
      recovery: Promise<void>
      lastGeneration: number
      closed: boolean
    } = { closed: false, recovery: Promise.resolve(), lastGeneration: 0 }
    const run = Effect.runPromise
    const recover = async () => {
      const shared = process.env.OPENCODE_HOME && (await KomaBackend.hasOtherInstances(process.env.OPENCODE_HOME))
      const owned = [...entries.values()]
        .filter((entry) => (entry.resumed || entry.executionObserved) && !entry.observedOnly)
        .map((entry) => entry.record.session.id)
      await run(sessions.recover(runtimeScope, shared ? owned : undefined))
    }
    const globalInstructions = () =>
      run(instructions.load({ engine: "codex" }).pipe(Effect.map(KomaInstructions.render)))
    const generation = (connected: CodexRuntime) => `${epoch}:${connected.generation}`
    const entryEpoch = (entry: Entry) => `${epoch}:${entry.generation ?? state.lastGeneration}`
    const current = (connected: CodexRuntime) =>
      state.runtime === connected && !connected.client.closed && !state.closed
    const fail = (code: HostError["code"], message: string): never => {
      throw new HostError({ code, message })
    }
    const result = <A>(fn: () => Promise<A>): Result<A> =>
      Effect.tryPromise({
        try: fn,
        catch: (error) =>
          error instanceof HostError ? error : new HostError({ code: "nativeError", message: errorMessage(error) }),
      })

    const notifyEngine = () => run(events.publish(EngineChanged, { engine: "codex" })).then(() => undefined)
    const descriptor = (entry: Entry): Descriptor => ({
      sessionID: entry.record.session.id,
      engine: "codex",
      epoch: entryEpoch(entry),
      revision: entry.revision,
      runtimeStatus: interactionStatus(entry),
      bindingState: entry.record.binding.state,
      capabilities: !enabled
        ? disabled
        : entry.record.binding.deletionState
          ? blocked
          : unconfirmedExecution(entry)
            ? blocked
            : unstartedBinding(entry.record.binding)
              ? { ...supported, prompt: false, steer: false }
              : entry.native?.canAcceptDirectInput === false
                ? { ...supported, prompt: false, steer: false, queue: "unavailable" }
                : supported,
      queuePaused: entry.record.binding.queuePaused,
      settings: effectiveSettings(entry),
      pendingSettings: pendingSettings(entry, effectiveSettings(entry)),
      inputWaitReason: entry.inputWaitReason,
      error: entry.error ?? entry.record.binding.deletionError,
    })

    function effectiveSettings(entry: Entry): Settings {
      return entry.appliedSettings.permission === "default" &&
        entry.desiredSettings.permission === "auto" &&
        entry.resumed &&
        state.runtime &&
        current(state.runtime) &&
        entry.generation === state.runtime.generation
        ? { ...entry.appliedSettings, permission: "auto" }
        : entry.appliedSettings
    }

    async function emit(entry: Entry, patch: Partial<Schema.Schema.Type<typeof Changed.data>> = {}) {
      entry.revision++
      if (patch.refresh && !patch.toolAppend) {
        const next = await snapshot(entry)
        const previous = entry.published
        if (previous && previous.descriptor.epoch === next.descriptor.epoch) {
          // Keep refresh for older clients. Updated clients apply the versioned
          // changes directly instead of downloading the complete history again.
          patch = { ...patch, ...snapshotUpdate(previous, next) }
        }
        entry.published = next
      } else if (entry.published) {
        entry.published = { ...entry.published, descriptor: descriptor(entry) }
        const appendID = patch.append?.messageID ?? patch.toolAppend?.messageID
        const changed =
          patch.messages ?? (appendID ? entry.view.messages.filter((message) => message.id === appendID) : [])
        if (changed.length) {
          const updates = new Map(changed.map((message) => [message.id, message]))
          entry.published = {
            ...entry.published,
            messages: entry.published.messages.map((message) => updates.get(message.id) ?? message),
          }
        }
      }
      await run(
        events.publish(
          Changed,
          {
            sessionID: entry.record.session.id,
            epoch: entryEpoch(entry),
            revision: entry.revision,
            descriptor: descriptor(entry),
            ...patch,
          },
          { location: entry.record.session.location },
        ),
      )
    }

    function serialize<A>(entry: Entry, fn: () => Promise<A>): Promise<A> {
      const operation = entry.operations.then(fn, fn)
      entry.operations = operation.then(
        () => undefined,
        () => undefined,
      )
      return operation
    }

    function serializeFamily<A>(family: Entry[], fn: () => Promise<A>) {
      const acquire = (index: number): Promise<A> => {
        // SessionExternal.family returns ancestry preorder. Match the existing
        // parent -> child notification nesting so overlapping work cannot cycle.
        const entry = family[index]
        return entry ? serialize(entry, () => acquire(index + 1)) : fn()
      }
      return acquire(0)
    }

    async function getEntry(sessionID: SessionSchema.ID) {
      const cached = entries.get(sessionID)
      if (cached) return cached
      const record = await run(sessions.get(sessionID))
      if (record.binding.runtimeScope !== runtimeScope)
        return fail("conflict", "The native session belongs to another Codex storage scope")
      const existing = entries.get(sessionID)
      if (existing) return existing
      const entry: Entry = {
        record,
        status:
          record.binding.state === "bound"
            ? "resolving"
            : record.binding.state === "unknown"
              ? "bindingUnavailable"
              : unstartedBinding(record.binding)
                ? "idle"
                : "creating",
        revision: 0,
        view: mutableView(emptyView()),
        items: new Map(),
        messageIndices: new Map(),
        blockedDeltas: new Set(),
        coveredSequence: 0,
        dirty: true,
        refreshPending: false,
        deletionChecks: 0,
        idleConfirmed: false,
        activeTools: new Map(),
        executionObserved: !record.binding.executionPending,
        appliedSettings: {},
        desiredSettings: decodeSettings(record.binding.settings),
        settingsSequence: 0,
        resumed: false,
        observedOnly: false,
        lease: false,
        controlSequence: 0,
        operations: Promise.resolve(),
        interactions: Promise.resolve(),
        leases: Promise.resolve(),
        pending: new Map(),
        diffs: {},
        itemTimes: {},
      }
      entries.set(sessionID, entry)
      if (record.binding.nativeThreadID) nativeSessions.set(record.binding.nativeThreadID, sessionID)
      return entry
    }

    function serializeLease<A>(entry: Entry, fn: () => Promise<A>) {
      const operation = entry.leases.then(fn, fn)
      entry.leases = operation.then(
        () => undefined,
        () => undefined,
      )
      return operation
    }

    function acquire(entry: Entry) {
      return serializeLease(entry, async () => {
        await run(ownership.invalidate(entry.record.session.id))
        if (entry.lease) return false
        const target = { directory: entry.record.session.location.directory, sessionID: entry.record.session.id }
        await run(worktrees.acquire(target))
        entry.lease = true
        entry.leaseTarget = target
        return true
      })
    }

    function confirmIdle(entry: Entry, connected: CodexRuntime, observedAt: number) {
      return serializeLease(entry, async () => {
        const threadID = entry.record.binding.nativeThreadID
        if (
          !current(connected) ||
          entry.generation !== connected.generation ||
          entry.activeTurnID ||
          entry.activeTools.size > 0 ||
          unconfirmedExecution(entry) ||
          [...entry.pending.values()].some((pending) => pending.blocking)
        )
          return
        if (threadID && (signals.get(threadID) ?? 0) > observedAt) return
        const confirmed = await run(
          ownership.confirmIdle({
            runtimeScope,
            generation: generation(connected),
            sessionID: entry.record.session.id,
          }),
        )
        if (!confirmed || !current(connected) || (threadID && (signals.get(threadID) ?? 0) > observedAt)) {
          await run(ownership.invalidate(entry.record.session.id))
          return
        }
        entry.record.binding = await run(sessions.setExecutionPending(entry.record.session.id, false))
        if (!current(connected) || (threadID && (signals.get(threadID) ?? 0) > observedAt)) {
          entry.record.binding = await run(sessions.setExecutionPending(entry.record.session.id, true))
          await run(ownership.invalidate(entry.record.session.id))
          return
        }
        entry.idleConfirmed = true
        if (!entry.lease) return
        const target = entry.leaseTarget
        entry.lease = false
        entry.leaseTarget = undefined
        if (target) await run(worktrees.release(target))
      })
    }

    function release(entry: Entry) {
      return serializeLease(entry, async () => {
        await run(ownership.invalidate(entry.record.session.id))
        const target = entry.leaseTarget
        entry.lease = false
        entry.leaseTarget = undefined
        if (target) await run(worktrees.release(target))
      })
    }

    function attach(entry: Entry, connected: CodexRuntime) {
      if (entry.generation === connected.generation) return
      entry.generation = connected.generation
      entry.executionObserved = !entry.record.binding.executionPending
      entry.resumed = false
      entry.observedOnly = false
      entry.idleConfirmed = false
      entry.activeTurnID = undefined
      entry.appliedSettings = {}
      entry.nativeProvider = undefined
      entry.providerConfig = undefined
      entry.globalInstructions = undefined
      entry.settingsSequence = 0
      entry.plan = undefined
      entry.dirty = true
      expireInteractions(entry, () => true, "Codex connection changed")
    }

    function interactionKey(nativeGeneration: number, id: unknown) {
      return `codex-${createHash("sha256")
        .update(JSON.stringify([runtimeScope, epoch, nativeGeneration, typeof id, id]))
        .digest("hex")}`
    }

    function rememberResolved(id: string) {
      resolvedRequests.add(id)
      if (resolvedRequests.size > 2048) resolvedRequests.delete(resolvedRequests.values().next().value!)
    }

    function expireInteractions(entry: Entry, predicate: (pending: PendingInteraction) => boolean, message: string) {
      for (const [id, pending] of entry.pending) {
        if (!predicate(pending)) continue
        rememberResolved(id)
        entry.pending.delete(id)
        pending.view = { ...pending.view, state: "expired" }
        pending.resolve({ error: { code: -32603, message } })
      }
    }

    function serializeInteraction<A>(entry: Entry, fn: () => Promise<A>) {
      const operation = entry.interactions.then(fn, fn)
      entry.interactions = operation.then(
        () => undefined,
        () => undefined,
      )
      return operation
    }

    async function runtime() {
      if (!enabled) return fail("unavailable", "Codex is not enabled for this backend")
      if (state.closed) return fail("unavailable", "Codex backend is closed")
      if (state.runtime && !state.runtime.client.closed) return state.runtime
      if (state.connecting) return state.connecting
      state.connecting = (async () => {
        await state.recovery
        await mkdir(home, { recursive: true })
        if (!state.manager)
          state.manager = new CodexRuntimeManager({
            binaryPath: await resolveBinary(global.home),
            codexHome: home,
            cwd: home,
            runtimeScope,
            args: ["-c", "tools.update_plan.enabled=true"],
            capabilities: { experimentalApi: true, requestAttestation: false },
            requestHandler: request,
          })
        const connected = await state.manager.get()
        state.runtime = connected
        state.lastGeneration = connected.generation
        await recover()
        await run(ownership.beginGeneration(runtimeScope, generation(connected)))
        if (!current(connected)) return fail("unavailable", "Codex connection closed during startup")
        connected.onNativeNotification((notification) => {
          receive(notification)
        })
        connected.client.onExit(() => {
          if (state.runtime !== connected) return
          state.runtime = undefined
          const recovery = (async () => {
            await run(ownership.invalidateScope(runtimeScope))
            await recover()
          })()
          state.recovery = recovery
          for (const entry of entries.values()) {
            void serialize(entry, async () => {
              await recovery
              if (entry.generation !== connected.generation) return
              const record = await run(sessions.get(entry.record.session.id))
              if (entry.generation !== connected.generation) return
              entry.resumed = false
              entry.executionObserved = false
              entry.idleConfirmed = false
              entry.appliedSettings = {}
              entry.nativeProvider = undefined
              entry.providerConfig = undefined
              entry.globalInstructions = undefined
              entry.plan = undefined
              entry.dirty = true
              entry.status = "disconnected"
              entry.error = "The Codex process disconnected; execution has not been retried"
              entry.record = record
              expireInteractions(
                entry,
                (pending) => pending.generation === connected.generation,
                "Codex connection closed",
              )
              await emit(entry, { refresh: true })
            }).catch(() => undefined)
          }
        })
        return connected
      })().finally(() => {
        state.connecting = undefined
      })
      return state.connecting
    }

    async function account(): Promise<Account> {
      return { authenticated: false, requiresAuth: false }
    }

    async function models() {
      const configured = await providers.list()
      return [
        ...configured.flatMap((provider) =>
          provider.models.map((model) => ({
            id: CodexProviders.modelID(provider.id, model.executionID ?? model.id),
            name: model.name,
            provider: { id: provider.id, name: provider.name },
            modelID: model.modelID ?? model.id,
            default: false,
            efforts: model.efforts,
            defaultEffort: model.defaultEffort,
            requiresAuth: false,
          })),
        ),
      ]
    }

    async function selectedModel(settings: Settings) {
      const configured = await providers.list()
      for (const provider of configured) {
        const model = provider.models.find(
          (model) => CodexProviders.modelID(provider.id, model.executionID ?? model.id) === settings.model,
        )
        if (!model) continue
        const providerID = CodexProviders.nativeProviderID(provider.id, model.executionID)
        return {
          model: model.id,
          modelProvider: providerID,
          serviceTier: model.serviceTier ?? null,
          config: {
            [`model_providers.${providerID}`]: await credentials.config(provider),
            // Responses-compatible providers do not imply support for OpenAI's
            // hosted web-search tool (for example XD's Bedrock models reject it).
            web_search: "disabled",
            ...(model.contextWindow ? { model_context_window: model.contextWindow } : {}),
          },
        }
      }
      return fail("invalid", "Select an available Provider model for this Codex task")
    }

    const unsubscribeProviders = providers.onChange(() => void notifyEngine().catch(() => undefined))
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeProviders))

    async function validateSettings(settings: Settings) {
      const available = await models()
      const selected = available.find((model) => model.id === settings.model)
      if (!selected) return fail("invalid", "The selected Codex model is unavailable")
      if (settings.effort && !selected.efforts.includes(settings.effort))
        return fail("invalid", "The selected reasoning effort is unavailable for this model")
      return selected
    }

    async function requireReady(settings: Settings) {
      await validateSettings(settings)
      // Recover existing deliveries before admitting a new durable input.
      await runtime()
    }

    function updateView(entry: Entry) {
      if (!entry.native) return
      const thread = entry.fallback
        ? { ...entry.native, turns: entry.native.turns.filter((turn) => !entry.fallback!.turns.has(turn.id)) }
        : entry.native
      const live = projectCodexView(
        projectThread(thread, {
          runtimeScope,
          revision: entry.revision,
          turnDiffs: entry.diffs,
          itemTimes: entry.itemTimes,
          usage: entry.usage ? { status: "available", value: entry.usage } : undefined,
        }),
        { sessionID: entry.record.session.id, childSessions: Object.fromEntries(nativeSessions) },
      )
      entry.view = mutableView(entry.fallback ? mergeViews(entry.fallback.view, live) : live)
      reindex(entry)
    }

    function reindex(entry: Entry) {
      entry.items.clear()
      for (const turn of entry.native?.turns ?? []) {
        for (const item of turn.items) entry.items.set(itemKey(turn.id, item.id), { turn, item })
      }
      entry.messageIndices = new Map(entry.view.messages.map((message, index) => [message.id, index]))
    }

    async function reconcile(entry: Entry, thread: v2.Thread) {
      if (thread.id !== entry.record.binding.nativeThreadID)
        return fail("conflict", "Cannot reconcile a different native thread")
      const evidence = new Map<string, Array<{ turnID: string; itemID: string }>>()
      for (const turn of thread.turns) {
        for (const item of turn.items) {
          if (item.type !== "userMessage" || !item.clientId) continue
          const values = evidence.get(item.clientId) ?? []
          if (!values.some((value) => value.turnID === turn.id && value.itemID === item.id))
            values.push({ turnID: turn.id, itemID: item.id })
          evidence.set(item.clientId, values)
        }
      }
      let unresolved = false
      for (const receipt of await run(sessions.deliveries(entry.record.session.id))) {
        if (!["sending", "unknown", "accepted"].includes(receipt.state) || receipt.nativeItemID) continue
        const matches = evidence.get(receipt.requestID)
        const deliveryGeneration = receipt.generation
        const nativeTurnID = receipt.nativeTurnID
        if (matches?.length !== 1 || !receipt.generation) {
          const turn = nativeTurnID ? thread.turns.find((value) => value.id === nativeTurnID) : undefined
          if (
            receipt.state === "accepted" &&
            deliveryGeneration &&
            nativeTurnID &&
            !matches?.length &&
            thread.historyMode === "paginated" &&
            turn?.itemsView === "full" &&
            turn.status !== "inProgress"
          ) {
            await run(
              sessions.settle({
                sessionID: receipt.sessionID,
                requestID: receipt.requestID,
                generation: deliveryGeneration,
                state: "returned",
                nativeTurnID,
                error: "Native turn ended before this input entered native history",
              }),
            )
            continue
          }
          if (receipt.state === "unknown") unresolved = true
          continue
        }
        await run(
          sessions.settle({
            sessionID: receipt.sessionID,
            requestID: receipt.requestID,
            generation: receipt.generation,
            state: "accepted",
            nativeTurnID: matches[0].turnID,
            nativeItemID: matches[0].itemID,
          }),
        )
      }
      if (unresolved)
        entry.error =
          "A previous input has an unknown result. Native history did not provide one exact client ID match; it has not been resent"
      return unresolved
    }

    function scheduleRefresh(entry: Entry) {
      const connected = state.runtime
      if (
        !connected ||
        !current(connected) ||
        entry.refreshTimer ||
        entry.refreshPending ||
        entry.activating ||
        entry.deletionChecks
      )
        return
      // No native cursor exists. Coalesce uncertain deltas into at most one read
      // every 200 ms; established new items still use the constant-size delta path.
      entry.refreshTimer = setTimeout(() => {
        entry.refreshTimer = undefined
        const observe = entry.observedOnly
        void refresh(entry, false, !observe, observe).then(
          (again) => {
            if (observe && !again && entry.native) scheduleActivation(entry)
            if (again) scheduleRefresh(entry)
          },
          (error) => {
            entry.dirty = true
            entry.error = errorMessage(error)
            if (current(connected)) void emit(entry, { refresh: true }).catch(() => undefined)
          },
        )
      }, 200)
    }

    async function refresh(entry: Entry, resume = false, dispatchReady = true, observe = false): Promise<boolean> {
      if (entry.activating && !observe) {
        await entry.activating
        if (resume && !entry.resumed) return refresh(entry, true, dispatchReady)
      }
      if (entry.refreshing) {
        await entry.refreshing
        if (resume && !entry.resumed) return refresh(entry, true, dispatchReady)
        return entry.dirty
      }
      entry.refreshPending = true
      const operation = load(entry, resume, observe)
      entry.refreshing = operation
      try {
        await operation
      } finally {
        if (entry.refreshing === operation) entry.refreshing = undefined
        entry.refreshPending = false
      }
      if (!observe && dispatchReady && !entry.deletionChecks && ["idle", "active"].includes(entry.status))
        dispatch(entry)
      if (entry.dirty) scheduleRefresh(entry)
      return entry.dirty
    }

    function scheduleActivation(entry: Entry) {
      const connected = state.runtime
      if (
        !connected ||
        !current(connected) ||
        entry.generation !== connected.generation ||
        entry.activating ||
        entry.resumed ||
        !entry.native ||
        entry.deletionChecks ||
        entry.record.binding.deletionState !== undefined ||
        entry.record.session.time.archived !== undefined ||
        entry.record.binding.state !== "bound"
      )
        return
      const operation = (async () => {
        entry.record = await run(sessions.get(entry.record.session.id))
        if (
          entry.record.session.time.archived !== undefined ||
          entry.record.binding.deletionState !== undefined ||
          entry.deletionChecks
        )
          return
        entry.refreshPending = true
        try {
          await load(entry, true, false, connected)
        } finally {
          entry.refreshPending = false
        }
        if (!entry.deletionChecks && ["idle", "active"].includes(entry.status)) dispatch(entry)
      })()
      entry.activating = operation
      void operation
        .then(
          () => {
            if (entry.activating === operation) entry.activating = undefined
            if (entries.get(entry.record.session.id) === entry && current(connected) && entry.dirty)
              scheduleRefresh(entry)
          },
          async (error) => {
            await serialize(entry, async () => {
              if (entry.activating !== operation) return
              entry.activating = undefined
              if (
                entries.get(entry.record.session.id) !== entry ||
                !current(connected) ||
                entry.generation !== connected.generation
              )
                return
              entry.status = state.runtime ? "bindingUnavailable" : "disconnected"
              entry.error = errorMessage(error)
              entry.dirty = !(error instanceof HostError && error.code === "invalid")
              await emit(entry)
            })
          },
        )
        .catch(() => undefined)
    }

    async function resumeModel(entry: Entry) {
      const deliveries = await run(sessions.deliveries(entry.record.session.id))
      // Only the first accepted input in a native turn selected its settings;
      // later steers did not. Desired settings may be newer and still pending.
      const turns = new Map<string, Settings>()
      for (const input of deliveries) {
        if (input.state !== "accepted" || !input.nativeTurnID || turns.has(input.nativeTurnID)) continue
        turns.set(input.nativeTurnID, decodeInput(input.payload).settings)
      }
      const applied = [...turns.values()].at(-1)
      const initial = deliveries[0] && decodeInput(deliveries[0].payload).settings
      const previous = applied ?? initial
      const available = await models()
      if (previous?.model && available.some((model) => model.id === previous.model)) return selectedModel(previous)
      // Legacy native-only settings are never inferred from the native default.
      // A user's explicit Provider selection can resume the same historical thread.
      return selectedModel(decodeSettings(entry.record.binding.settings))
    }

    async function load(entry: Entry, resume = false, observe = false, existing?: CodexRuntime) {
      const connected = existing ?? (await runtime())
      if (!current(connected)) return fail("unavailable", "Codex connection changed before loading")
      attach(entry, connected)
      entry.observedOnly = observe
      const threadID = entry.record.binding.nativeThreadID
      if (!threadID) return
      const observedAt = receiveSequence
      if (resume && !entry.resumed) {
        const selected = await resumeModel(entry)
        if (entry.deletionChecks) return
        const response = await connected.resumeThread(
          threadID,
          {
            ...selected,
            developerInstructions: await globalInstructions(),
            cwd: entry.record.session.location.directory,
            excludeTurns: true,
          },
          { timeoutMs: 15_000 },
        )
        if (entry.deletionChecks) return
        if (!current(connected)) return fail("unavailable", "Codex connection changed while resuming")
        if (
          response.thread.id !== threadID ||
          !(await sameDirectory(response.cwd, entry.record.session.location.directory))
        )
          return fail("conflict", "Codex resumed a different native thread or directory")
        if (!current(connected)) return fail("unavailable", "Codex connection changed while checking the directory")
        if (entry.settingsSequence <= observedAt) {
          entry.appliedSettings = observedSettings(response)
          entry.nativeProvider = response.modelProvider
          // Resume may rejoin an already loaded child and ignore overrides.
          // Confirm custom config only after an explicit idle unload/resume.
          entry.providerConfig = undefined
          entry.globalInstructions = undefined
        }
        entry.resumed = true
        scheduleAutomaticApprovals(entry)
      }
      const metadata = await connected.readThread(threadID, false, { timeoutMs: 15_000 })
      if (!current(connected)) return fail("unavailable", "Codex connection changed while reading")
      if (
        metadata.thread.id !== threadID ||
        !(await sameDirectory(metadata.thread.cwd, entry.record.session.location.directory))
      )
        return fail("conflict", "Codex returned a different native thread or directory")
      if (!current(connected)) return fail("unavailable", "Codex connection changed while checking the directory")
      if ((signals.get(threadID) ?? 0) > observedAt) {
        entry.dirty = true
        scheduleRefresh(entry)
        return
      }
      await syncTitle(entry, metadata.thread.name)
      const history = await connected.readThread(threadID, true, { timeoutMs: 15_000 }).catch(async (error) => {
        if (error instanceof CodexRpcError && metadata.thread.path) {
          return {
            fallback: await readCodexRolloutHistory({
              codexHome: home,
              path: metadata.thread.path,
              expectedThreadID: threadID,
              runtimeScope,
            }),
          }
        }
        if (
          error instanceof CodexRpcError &&
          !metadata.thread.path &&
          !(await run(sessions.deliveries(entry.record.session.id))).some(
            (item) => item.state === "accepted" || item.state === "unknown",
          )
        ) {
          return { thread: metadata.thread }
        }
        throw error
      })
      if (!current(connected)) return fail("unavailable", "Codex connection changed while reading history")
      if ((signals.get(threadID) ?? 0) > observedAt) {
        entry.dirty = true
        scheduleRefresh(entry)
        return
      }
      // App-server has no snapshot cursor. Previously existing items cannot safely
      // accept any later delta: that fragment may already be in this read. Only
      // complete items or another full read replace them. New item/started events
      // received after this barrier may establish their own streaming baseline.
      entry.coveredSequence = receiveSequence
      entry.blockedDeltas.clear()
      entry.error = undefined
      if (history.thread) {
        if (history.thread.id !== threadID) return fail("conflict", "Codex returned history for another thread")
        entry.native = history.thread
        entry.fallback = undefined
        for (const turn of history.thread.turns)
          for (const item of turn.items) {
            entry.blockedDeltas.add(itemKey(turn.id, item.id))
            if (!observe) {
              if (runningTool(item))
                entry.activeTools.set(
                  itemKey(turn.id, item.id),
                  entry.activeTools.get(itemKey(turn.id, item.id)) ?? {
                    turnID: turn.id,
                    generation: connected.generation,
                  },
                )
              else if ("status" in item) entry.activeTools.delete(itemKey(turn.id, item.id))
            }
          }
        if (!observe) await reconcile(entry, history.thread)
        // Paginated history persists the real item IDs and execution states.
        // Legacy hydration omits Code Mode commands, so it is never evidence
        // that an execution interrupted across a host restart has quiesced.
        if (
          !observe &&
          unconfirmedExecution(entry) &&
          history.thread.historyMode === "paginated" &&
          history.thread.status.type === "idle" &&
          history.thread.turns.every(
            (turn) =>
              turn.itemsView === "full" &&
              turn.status !== "inProgress" &&
              turn.items.every((item) => !runningTool(item)),
          )
        ) {
          const dispatched = (await run(sessions.deliveries(entry.record.session.id))).filter((receipt) =>
            ["sending", "accepted", "unknown"].includes(receipt.state),
          )
          const ended = dispatched.every((receipt) =>
            history.thread!.turns.some(
              (turn) =>
                turn.id === receipt.nativeTurnID ||
                turn.items.some((item) => item.type === "userMessage" && item.clientId === receipt.requestID),
            ),
          )
          if (ended && !entry.activeTools.size) entry.executionObserved = true
        }
      } else {
        // Retain an explicit fallback base. Metadata-only updates must never
        // replace it with an empty native transcript or guess matching item IDs.
        entry.fallback = {
          view: projectCodexRolloutView(history.fallback, {
            sessionID: entry.record.session.id,
            childSessions: Object.fromEntries(nativeSessions),
          }),
          turns: new Set(history.fallback.turns.map((turn) => turn.nativeID)),
        }
        entry.native = { ...metadata.thread, turns: entry.native?.turns ?? [] }
        if ((await run(sessions.deliveries(entry.record.session.id))).some((receipt) => receipt.state === "unknown")) {
          entry.error =
            "A previous input remains unknown: the available rollout history has no verified native client ID evidence. It has not been resent"
        }
      }
      if ((signals.get(threadID) ?? 0) > observedAt) {
        entry.dirty = true
        scheduleRefresh(entry)
        return
      }
      updateView(entry)
      if (observe) {
        entry.status =
          entry.record.session.time.archived === undefined
            ? "resolving"
            : executionStatus(entry, nativeStatus(entry.native.status))
        entry.dirty = false
        await emit(entry, { refresh: true })
        return
      }
      const native = entry.native
      const active = native.turns.filter((turn) => turn.status === "inProgress")
      entry.activeTurnID = native.status.type === "active" && active.length === 1 ? active[0].id : undefined
      entry.status = executionStatus(entry, nativeStatus(native.status))
      if (unconfirmedExecution(entry))
        entry.error = "Previous native execution has no confirmed completion; input and queued execution remain blocked"
      entry.appliedSettings = {
        ...entry.appliedSettings,
        // thread/read retains the creation provider even after an idle provider
        // switch. Effective settings come from resume/turn notifications.
        model:
          entry.appliedSettings.model ??
          CodexProviders.observedModel(native.model, entry.nativeProvider ?? native.modelProvider),
        effort:
          entry.settingsSequence <= observedAt
            ? (native.reasoningEffort ?? entry.appliedSettings.effort)
            : entry.appliedSettings.effort,
      }
      entry.dirty = (signals.get(threadID) ?? 0) > observedAt
      entry.idleConfirmed = false
      if (entry.status === "idle") {
        const last = native.turns.at(-1)
        if (last?.status === "failed") entry.error ??= last.error?.message ?? "The native turn failed"
        await resolveChildren(entry)
        await confirmIdle(entry, connected, observedAt)
      } else if (["active", "waitingApproval", "waitingInput"].includes(entry.status)) await acquire(entry)
      await emit(entry, { refresh: true })
      if (entry.dirty) scheduleRefresh(entry)
    }

    async function bind(entry: Entry, connected: CodexRuntime) {
      entry.record = await run(sessions.get(entry.record.session.id))
      if (entry.record.binding.state === "bound") return
      if (entry.record.binding.state !== "pending")
        return fail("conflict", "Native thread creation is unresolved; it will not be repeated")
      const token = generation(connected)
      const observedAt = receiveSequence
      const options = {
        ...threadSettings(decodeSettings(entry.record.binding.settings)),
        ...(await selectedModel(decodeSettings(entry.record.binding.settings))),
        developerInstructions: await globalInstructions(),
        cwd: entry.record.session.location.directory,
        historyMode: "paginated" as const,
      }
      // Lease/validation/publication failures happen before the durable claim.
      await acquire(entry)
      entry.status = "creating"
      await emit(entry, { refresh: true })
      if (!current(connected)) return fail("unavailable", "Codex connection changed before thread creation")
      const claimed = await run(sessions.claimBinding({ sessionID: entry.record.session.id, generation: token }))
      if (!claimed) return fail("conflict", "Native thread creation is already claimed")
      entry.record.binding = claimed
      try {
        entry.record.binding = await run(sessions.setExecutionPending(entry.record.session.id, true))
        entry.executionObserved = true
        const started = await connected.startThread(options, { timeoutMs: 30_000 })
        entry.record.binding = await run(
          sessions.reconcileBinding({
            sessionID: entry.record.session.id,
            runtimeScope,
            nativeThreadID: started.thread.id,
            generation: token,
          }),
        )
        nativeSessions.set(started.thread.id, entry.record.session.id)
        if (started.modelProvider !== options.modelProvider)
          return fail("conflict", "Codex did not apply the selected provider")
        if (!current(connected) || entry.generation !== connected.generation) return
        for (const notification of buffered.get(started.thread.id) ?? []) observeTool(entry, notification)
        entry.native = started.thread
        entry.resumed = true
        if (entry.settingsSequence <= observedAt) {
          entry.appliedSettings = observedSettings(started)
          entry.nativeProvider = started.modelProvider
          entry.providerConfig = JSON.stringify(options.config)
          entry.globalInstructions = options.developerInstructions
        }
        scheduleAutomaticApprovals(entry)
        entry.status = executionStatus(entry, nativeStatus(started.thread.status))
        entry.idleConfirmed = entry.status === "idle"
        updateView(entry)
        // Do not release the creation lease between thread/start and the first
        // input. Buffered notifications retain their ingress sequence and order.
        drainBuffered(entry)
        await emit(entry, { refresh: true })
      } catch (error) {
        const record = await run(sessions.get(entry.record.session.id))
        if (record.binding.state !== "bound") {
          await run(
            sessions.markBindingUnknown({
              sessionID: entry.record.session.id,
              generation: token,
              error: errorMessage(error),
            }),
          )
        }
        if (current(connected) && entry.generation === connected.generation) {
          entry.record = await run(sessions.get(entry.record.session.id))
          entry.status = "bindingUnavailable"
          entry.error = errorMessage(error)
          await emit(entry, { refresh: true })
        }
        throw error
      }
    }

    async function deliver(entry: Entry, requestID: string) {
      const connected = await runtime()
      attach(entry, connected)
      const token = generation(connected)
      await bind(entry, connected)
      if (!current(connected)) return
      if (!entry.resumed || entry.dirty || entry.status === "disconnected") {
        void refresh(entry, true).catch(async (error) => {
          entry.error = errorMessage(error)
          await emit(entry, { refresh: true })
        })
        return
      }
      if (unconfirmedExecution(entry))
        return fail("conflict", "Previous native execution has not been confirmed finished")
      const input = await run(sessions.getDelivery({ sessionID: entry.record.session.id, requestID }))
      if (!input || input.state !== "pending") {
        if (entry.status === "idle") await confirmIdle(entry, connected, receiveSequence)
        return
      }
      entry.record = await run(sessions.get(entry.record.session.id))
      if (entry.native?.canAcceptDirectInput === false)
        return fail("conflict", "This native thread does not accept direct input")
      if (input.delivery === "queue" && (entry.status !== "idle" || entry.record.binding.queuePaused)) return
      if (!["idle", "active"].includes(interactionStatus(entry))) return
      if (entry.status === "active" && !entry.activeTurnID)
        return fail("conflict", "The active native turn ID is unavailable; input has not been dispatched")
      if (entry.status === "idle" && !entry.idleConfirmed) return
      const payload = decodeInput(input.payload)
      const nativeInput = codexInput(payload)
      const selected = await selectedModel(payload.settings)
      const developerInstructions = await globalInstructions()
      const options = turnSettings(
        { ...payload.settings, model: selected.model },
        entry.record.session.location.directory,
      )
      const activeTurnID = entry.activeTurnID
      const switchConfiguration =
        selected.modelProvider !== entry.nativeProvider ||
        JSON.stringify(selected.config) !== entry.providerConfig ||
        developerInstructions !== entry.globalInstructions
      const activeConfigurationChange =
        (payload.settings.model !== undefined && payload.settings.model !== entry.appliedSettings.model) ||
        (payload.settings.effort !== undefined && payload.settings.effort !== entry.appliedSettings.effort) ||
        (payload.settings.permission !== undefined &&
          payload.settings.permission !== effectiveSettings(entry).permission) ||
        (entry.nativeProvider !== undefined && selected.modelProvider !== entry.nativeProvider) ||
        (entry.providerConfig !== undefined && JSON.stringify(selected.config) !== entry.providerConfig) ||
        (entry.globalInstructions !== undefined && developerInstructions !== entry.globalInstructions)
      // A steer cannot change providers or global instructions. Apply changes
      // only once native execution is idle, before dispatching the next input.
      if (activeTurnID && activeConfigurationChange) {
        entry.inputWaitReason = "waitingForConfiguration"
        return
      }
      await acquire(entry)
      if (!activeTurnID && switchConfiguration) {
        if (!entry.idleConfirmed || entry.status !== "idle" || entry.activeTurnID) return
        // Loaded threads ignore provider overrides. Unsubscribe only after the
        // ownership lane has confirmed idle, then resume the same durable ID.
        const threadID = entry.record.binding.nativeThreadID!
        const unsubscribed = await connected.client.request<"thread/unsubscribe", v2.ThreadUnsubscribeResponse>(
          "thread/unsubscribe",
          { threadId: threadID },
        )
        if (unsubscribed.status !== "unsubscribed" && unsubscribed.status !== "notLoaded")
          return fail("conflict", "Codex could not unload the idle thread to select its provider")
        entry.resumed = false
        entry.idleConfirmed = false
        const resumed = await connected.resumeThread(
          threadID,
          {
            ...selected,
            developerInstructions,
            cwd: entry.record.session.location.directory,
            excludeTurns: true,
          },
          { timeoutMs: 15_000 },
        )
        if (!current(connected) || resumed.thread.id !== threadID)
          return fail("unavailable", "Codex connection changed while selecting the provider")
        if (!(await sameDirectory(resumed.cwd, entry.record.session.location.directory)))
          return fail("conflict", "Codex resumed a different directory while selecting the provider")
        if (resumed.modelProvider !== selected.modelProvider)
          return fail("conflict", "Codex did not apply the selected provider")
        entry.nativeProvider = resumed.modelProvider
        entry.providerConfig = JSON.stringify(selected.config)
        entry.globalInstructions = developerInstructions
        entry.appliedSettings = observedSettings(resumed)
        entry.resumed = true
        entry.idleConfirmed = true
      }
      // An event consumer failure must not strand a claimed but undispatched row.
      await emit(entry, { refresh: true })
      if (!current(connected)) return fail("unavailable", "Codex connection changed before input dispatch")
      const claimed = await run(sessions.claim({ sessionID: entry.record.session.id, requestID, generation: token }))
      if (!claimed) {
        if (entry.status === "idle") await confirmIdle(entry, connected, receiveSequence)
        return
      }
      entry.record.binding = { ...entry.record.binding, executionPending: true }
      entry.executionObserved = true
      entry.idleConfirmed = false
      entry.status = "active"
      entry.error = undefined
      entry.inputWaitReason = undefined
      const dispatchedAt = receiveSequence
      const response = activeTurnID
        ? connected.steerTurn(
            {
              threadId: entry.record.binding.nativeThreadID!,
              expectedTurnId: activeTurnID,
              clientUserMessageId: requestID,
              input: nativeInput,
            },
            { timeoutMs: 30_000 },
          )
        : connected.startTurn(
            {
              ...options,
              serviceTier: selected.serviceTier,
              threadId: entry.record.binding.nativeThreadID!,
              cwd: entry.record.session.location.directory,
              clientUserMessageId: requestID,
              input: nativeInput,
            },
            { timeoutMs: 30_000 },
          )
      void response
        .then(
          (response) =>
            serialize(entry, async () => {
              const nativeTurnID = "turnId" in response ? response.turnId : response.turn.id
              await run(
                sessions.settle({
                  sessionID: entry.record.session.id,
                  requestID,
                  generation: token,
                  state: "accepted",
                  nativeTurnID,
                }),
              )
              if (!current(connected) || entry.generation !== connected.generation) return
              if ((signals.get(entry.record.binding.nativeThreadID!) ?? 0) > dispatchedAt) {
                entry.dirty = true
                scheduleRefresh(entry)
                await emit(entry, { refresh: true })
                await pump(entry)
                return
              }
              entry.activeTurnID = nativeTurnID
              // A turn/start response acknowledges execution, but its items are not a
              // history cursor. Display content only from the ordered item stream/read.
              if ("turn" in response && entry.native && !entry.native.turns.some((turn) => turn.id === nativeTurnID)) {
                entry.native.turns.push({ ...response.turn, items: [] })
                reindex(entry)
              }
              await emit(entry, { refresh: true })
              await pump(entry)
            }),
          (error) =>
            serialize(entry, async () => {
              const rejected = error instanceof CodexRpcError && [-32600, -32601, -32602].includes(error.code)
              await run(
                sessions.settle({
                  sessionID: entry.record.session.id,
                  requestID,
                  generation: token,
                  state: rejected ? "rejected" : "unknown",
                  error: errorMessage(error),
                }),
              )
              if (!current(connected) || entry.generation !== connected.generation) return
              entry.record.binding = await run(sessions.pause(entry.record.session.id))
              entry.error = errorMessage(error)
              entry.dirty = true
              entry.status = rejected ? "systemError" : "disconnected"
              await emit(entry, { refresh: true })
            }),
        )
        .catch(() => undefined)
      await emit(entry, { refresh: true })
    }

    async function pump(entry: Entry) {
      if (entry.deletionChecks) return
      entry.record = await run(sessions.get(entry.record.session.id))
      const status = interactionStatus(entry)
      const deliveries = await run(sessions.deliveries(entry.record.session.id))
      const pending = await run(sessions.pending(entry.record.session.id))
      if (entry.record.binding.state === "pending") {
        const next = pending[0]
        entry.inputWaitReason = next ? undefined : inputWaitReason(entry, deliveries)
        if (next) await deliver(entry, next.requestID)
        return
      }
      if (!["idle", "active"].includes(status) || (status === "idle" && !entry.idleConfirmed)) return
      const next = status === "active" ? pending.find((item) => item.delivery === "steer") : pending[0]
      entry.inputWaitReason = next ? undefined : inputWaitReason(entry, deliveries)
      if (next) await deliver(entry, next.requestID)
    }

    async function snapshot(entry: Entry): Promise<Snapshot> {
      const deliveries = await run(sessions.deliveries(entry.record.session.id))
      entry.inputWaitReason = inputWaitReason(entry, deliveries)
      return {
        ...structuredClone(entry.view),
        descriptor: descriptor(entry),
        plan: entry.plan ? { status: "available", value: structuredClone(entry.plan) } : { status: "unavailable" },
        interactions: [...entry.pending.values()].map((pending) => pending.view),
        deliveries: deliveries.map((delivery) => deliveryView(delivery, entry, deliveries)),
        children: [...new Set(entry.view.nativeChildren.map((child) => child.nativeThreadID))].flatMap(
          (nativeThreadID) => {
            const sessionID = nativeSessions.get(nativeThreadID)
            return sessionID ? [{ sessionID, nativeThreadID }] : []
          },
        ),
      }
    }

    async function resolveNative(threadID: string): Promise<Entry | undefined> {
      if (await run(sessions.wasDeleted({ runtimeScope, nativeThreadID: threadID }))) {
        buffered.delete(threadID)
        return
      }
      const known = nativeSessions.get(threadID)
      if (known) return getEntry(known)
      const connected = state.runtime
      if (!connected) return
      const key = `${connected.generation}:${threadID}`
      const existing = resolving.get(key)
      if (existing) return existing
      const operation = (async () => {
        const native = (await connected.readThread(threadID, false, { timeoutMs: 15_000 })).thread
        if (!current(connected) || native.id !== threadID) return
        const parentID = native.parentThreadId ? nativeSessions.get(native.parentThreadId) : undefined
        if (!parentID) return
        const parent = await getEntry(parentID)
        const child = await run(
          sessions.adoptChild({
            parentID,
            runtimeScope,
            nativeThreadID: threadID,
            location: Location.Ref.make({ directory: AbsolutePath.make(native.cwd) }),
            title: native.name ?? native.preview ?? undefined,
            settings: parent.record.binding.settings,
          }),
        ).catch(async (error) => {
          if (await run(sessions.wasDeleted({ runtimeScope, nativeThreadID: threadID }))) return
          throw error
        })
        if (!child) {
          buffered.delete(threadID)
          return
        }
        const entry = await getEntry(child.session.id)
        await serialize(entry, async () => {
          if (!current(connected)) return
          attach(entry, connected)
          const pending = buffered.get(threadID) ?? []
          entry.executionObserved = pending.some(
            (value) => value.generation === connected.generation && value.method === "thread/started",
          )
          for (const value of pending) observeTool(entry, value)
          entry.native = { ...native, turns: entry.native?.turns ?? [] }
          entry.status = nativeStatus(native.status)
          if (native.status.type === "active") await acquire(entry)
          // Read each adopted child's real history before confirming it idle:
          // completed parents can still have running descendants.
          await load(entry)
          drainBuffered(entry)
        })
        return entry
      })().finally(() => resolving.delete(key))
      resolving.set(key, operation)
      return operation
    }

    async function resolveChildren(entry: Entry) {
      for (const child of entry.view.nativeChildren) {
        if (child.nativeThreadID === entry.record.binding.nativeThreadID) continue
        // Failure keeps the parent lease: an undiscovered child must not make a
        // shared worktree appear safe to archive.
        if (await resolveNative(child.nativeThreadID)) continue
        if (await run(sessions.wasDeleted({ runtimeScope, nativeThreadID: child.nativeThreadID }))) continue
        throw new Error("Native child ownership could not be resolved")
      }
    }

    async function resolveKnownFamily(entry: Entry, seen = new Set<string>()) {
      const nativeThreadID = entry.record.binding.nativeThreadID
      if (!nativeThreadID || seen.has(nativeThreadID)) return
      seen.add(nativeThreadID)
      for (const child of entry.view.nativeChildren) {
        const resolved = await resolveNative(child.nativeThreadID)
        if (!resolved) {
          if (await run(sessions.wasDeleted({ runtimeScope, nativeThreadID: child.nativeThreadID }))) continue
          return fail("conflict", "Native child ownership could not be resolved")
        }
        await resolveKnownFamily(resolved, seen)
      }
    }

    function drainBuffered(entry: Entry) {
      const threadID = entry.record.binding.nativeThreadID
      if (!threadID) return
      const pending = buffered.get(threadID)
      buffered.delete(threadID)
      for (const notification of pending ?? []) {
        void serialize(entry, () => notificationReceived(entry, notification)).catch(() => {
          entry.dirty = true
        })
      }
    }

    function receive(notification: CodexServerNotification) {
      if (notification.generation !== state.runtime?.generation) return
      const received = { ...notification, sequence: ++receiveSequence }
      const params = record(notification.params) ? notification.params : {}
      if (notification.method.startsWith("account/")) return
      const threadID =
        typeof params.threadId === "string"
          ? params.threadId
          : record(params.thread) && typeof params.thread.id === "string"
            ? params.thread.id
            : undefined
      if (!threadID) return
      const toolStarted = notification.method === "item/started" && runningTool(params.item)
      signals.set(threadID, received.sequence)
      if (notification.method === "serverRequest/resolved")
        rememberResolved(interactionKey(notification.generation, params.requestId))
      const id = nativeSessions.get(threadID)
      const entry = id ? entries.get(id) : undefined
      if (entry) {
        observeSettings(entry, received)
        if (
          notification.method === "turn/started" ||
          toolStarted ||
          (notification.method === "thread/status/changed" && record(params.status) && params.status.type !== "idle")
        ) {
          entry.idleConfirmed = false
          void run(ownership.invalidate(entry.record.session.id)).catch(() => undefined)
        }
        void serialize(entry, () => notificationReceived(entry, received)).catch((error) => {
          entry.dirty = true
          entry.error = errorMessage(error)
        })
        return
      }
      const pending = buffered.get(threadID) ?? []
      if (pending.length < 256) pending.push(received)
      if (buffered.size < 256 || buffered.has(threadID)) buffered.set(threadID, pending)
      void resolveNative(threadID)
        .then((entry) => {
          if (entry) drainBuffered(entry)
        })
        .catch(() => undefined)
    }

    async function notificationReceived(entry: Entry, notification: Received) {
      const connected = state.runtime
      if (!connected || notification.generation !== connected.generation) return
      if (
        entries.get(entry.record.session.id) !== entry ||
        entry.deletionChecks ||
        entry.record.binding.deletionState
      ) {
        entry.dirty = true
        return
      }
      attach(entry, connected)
      observeSettings(entry, notification)
      const params = record(notification.params) ? notification.params : {}
      if (notification.method === "turn/plan/updated") {
        const plan = {
          turnID: params.turnId,
          ...(typeof params.explanation === "string" ? { explanation: params.explanation } : {}),
          steps: params.plan,
        }
        if (Schema.is(Plan)(plan)) entry.plan = plan
      }
      const toolObserved = observeTool(entry, notification)
      if (toolObserved && entry.activeTools.size > 0) {
        entry.record.binding = await run(sessions.setExecutionPending(entry.record.session.id, true))
        await acquire(entry)
      }
      const key =
        typeof params.turnId === "string" && typeof params.itemId === "string"
          ? itemKey(params.turnId, params.itemId)
          : undefined
      const delta =
        notification.method.endsWith("/delta") ||
        notification.method.endsWith("Delta") ||
        notification.method === "item/fileChange/patchUpdated"
      if (delta) {
        if (!key) return
        if (notification.sequence <= entry.coveredSequence || entry.blockedDeltas.has(key)) {
          entry.dirty = true
          scheduleRefresh(entry)
          return
        }
        const found = entry.items.get(key)
        if (!found || entry.fallback?.turns.has(found.turn.id) || !entry.native) {
          entry.dirty = true
          scheduleRefresh(entry)
          return
        }
        applyItemNotification(found.item, notification)
        const projected = projectCodexView(
          projectThread(
            { ...entry.native, turns: [{ ...found.turn, items: [found.item] }] },
            { runtimeScope, revision: entry.revision, itemTimes: entry.itemTimes },
          ),
          { sessionID: entry.record.session.id, childSessions: Object.fromEntries(nativeSessions) },
        )
        const message = projected.messages[0]
        if (!message) return
        const index = entry.messageIndices.get(message.id)
        if (index === undefined) return
        const previous = entry.view.messages[index]
        entry.view.messages[index] = message
        const append = textAppend([previous], [message])
        const toolAppend = !append ? toolOutputAppend(previous, message) : undefined
        await emit(entry, append ? { append } : toolAppend ? { toolAppend, refresh: true } : { messages: [message] })
        return
      }
      if (notification.method === "serverRequest/resolved") {
        const id = interactionKey(notification.generation, params.requestId)
        await serializeInteraction(entry, async () => {
          const pending = entry.pending.get(id)
          if (!pending) return
          pending.resolve({ error: { code: -32603, message: "Native interaction was cleared" } })
          entry.pending.delete(id)
          if (
            pending.blocking &&
            entry.activeTurnID &&
            ![...entry.pending.values()].some((value) => value.blocking) &&
            ["waitingInput", "waitingApproval"].includes(entry.status)
          )
            entry.status = "active"
        })
      }
      // Events received during a read have no defined position relative to its
      // snapshot. Do not replay them as if they were newer, or treat them as
      // proven covered: request another read before confirming current state.
      if (notification.sequence <= entry.coveredSequence && notification.method !== "serverRequest/resolved") {
        entry.dirty = true
        entry.idleConfirmed = false
        scheduleRefresh(entry)
        return
      }
      if (
        notification.method === "item/started" &&
        record(params.item) &&
        typeof params.turnId === "string" &&
        typeof params.item.id === "string"
      ) {
        const item = itemKey(params.turnId, params.item.id)
        if (entry.blockedDeltas.has(item)) {
          entry.dirty = true
          scheduleRefresh(entry)
          return
        }
      }
      if (
        ["item/started", "item/completed"].includes(notification.method) &&
        record(params.item) &&
        typeof params.turnId === "string"
      ) {
        const projected = projectItem(params.item as v2.ThreadItem, {
          runtimeScope,
          threadID: entry.record.binding.nativeThreadID!,
          turnID: params.turnId,
        })
        const previous = entry.itemTimes[projected.id] ?? {}
        entry.itemTimes[projected.id] = {
          ...previous,
          ...(typeof params.startedAtMs === "number" ? { created: params.startedAtMs } : {}),
          ...(typeof params.completedAtMs === "number" ? { completed: params.completedAtMs } : {}),
        }
      }
      applyNotification(entry, notification)
      if (
        notification.method === "item/completed" &&
        record(params.item) &&
        typeof params.turnId === "string" &&
        typeof params.item.id === "string"
      ) {
        entry.blockedDeltas.add(itemKey(params.turnId, params.item.id))
      }
      if (
        ["item/started", "item/completed"].includes(notification.method) &&
        record(params.item) &&
        params.item.type === "userMessage" &&
        entry.native
      )
        await reconcile(entry, entry.native)
      if (notification.method === "error" && record(params.error) && typeof params.error.message === "string")
        entry.error = params.error.message
      if (notification.method === "thread/name/updated" && typeof params.threadName === "string") {
        if (entry.native) entry.native.name = params.threadName
        await syncTitle(entry, params.threadName)
      }
      if (notification.method === "thread/status/changed" && record(params.status)) {
        if (entry.native) entry.native.status = params.status as v2.ThreadStatus
        if (params.status.type === "idle") entry.activeTurnID = undefined
        entry.status = executionStatus(entry, nativeStatus(params.status as v2.ThreadStatus))
        if (entry.status !== "idle") {
          entry.idleConfirmed = false
          await acquire(entry)
        }
      }
      if (notification.method === "turn/started" && record(params.turn) && typeof params.turn.id === "string") {
        entry.activeTurnID = params.turn.id
        entry.status = "active"
        if (entry.native) entry.native.status = { type: "active", activeFlags: [] }
        entry.idleConfirmed = false
        await acquire(entry)
      }
      if (notification.method === "turn/completed" && record(params.turn)) {
        const turn = params.turn as v2.Turn
        for (const item of entry.native?.turns.find((value) => value.id === turn.id)?.items ?? [])
          entry.blockedDeltas.add(itemKey(turn.id, item.id))
        if (entry.activeTurnID === turn.id || !entry.activeTurnID) {
          entry.activeTurnID = undefined
          if (entry.native) entry.native.status = { type: "idle" }
          entry.status = executionStatus(entry, "idle", turn.status === "interrupted")
        }
        expireInteractions(
          entry,
          (pending) => pending.blocking && pending.view.turnRef === turn.id,
          "Native turn ended",
        )
        if (turn.status === "failed") {
          entry.error = turn.error?.message ?? "The native turn failed"
          await run(sessions.setQueuePaused(entry.record.session.id, true))
          entry.record = await run(sessions.get(entry.record.session.id))
        }
      }
      if (toolObserved && entry.native?.status.type === "idle") entry.status = executionStatus(entry, "idle")
      updateView(entry)
      if (notification.method === "turn/started" || notification.method === "turn/completed") {
        const timestamp = record(params.turn) ? (params.turn.completedAt ?? params.turn.startedAt) : undefined
        if (typeof timestamp === "number") await run(sessions.touch(entry.record.session.id, timestamp * 1000))
      }
      if (notification.method === "turn/completed") {
        entry.dirty = true
        entry.idleConfirmed = false
        await emit(entry, { refresh: true })
        scheduleRefresh(entry)
        return
      }
      if (entry.status === "idle") {
        await resolveChildren(entry)
        await confirmIdle(entry, connected, notification.sequence)
      }
      await emit(entry, { refresh: true })
      if (["idle", "active"].includes(entry.status)) dispatch(entry, "native-status")
    }

    async function request(native: CodexServerRequest): Promise<CodexServerRequestResult> {
      const connected = state.runtime
      if (!connected || native.generation !== connected.generation)
        return { error: { code: -32603, message: "Stale Codex connection" } }
      const params = record(native.params) ? native.params : {}
      if (native.method.startsWith("account/")) {
        return { error: { code: -32601, message: "Codex authentication is managed by the selected Provider" } }
      }
      if (typeof params.threadId !== "string")
        return { error: { code: -32601, message: `Unsupported native request: ${native.method}` } }
      signals.set(params.threadId, ++receiveSequence)
      const entry = await resolveNative(params.threadId)
      if (!entry) return { error: { code: -32602, message: "Unknown native session" } }
      entry.idleConfirmed = false
      await run(ownership.invalidate(entry.record.session.id))
      const id = interactionKey(native.generation, native.id)
      const interaction = await createCodexInteraction(native, {
        id,
        sessionID: entry.record.session.id,
        revision: entry.revision + 1,
      }).catch(async (error) => {
        entry.error = `Unsupported native interaction: ${errorMessage(error)}`
        await emit(entry, { refresh: true })
        return undefined
      })
      if (!interaction) {
        entry.error ??= `Unsupported native request: ${native.method}`
        await emit(entry, { refresh: true })
        return { error: { code: -32601, message: entry.error } }
      }
      const blocking = !(native.method === "item/tool/requestUserInput" && params.isBlocking === false)
      // This lane protects registration/replies, but never awaits the user's
      // response. Native requests can precede their turn/start RPC response.
      const registered = await serializeInteraction(entry, async () => {
        if (!current(connected) || resolvedRequests.has(id))
          return { error: { code: -32603, message: "Native interaction is no longer pending" } }
        await acquire(entry)
        if (!current(connected) || resolvedRequests.has(id))
          return { error: { code: -32603, message: "Native interaction is no longer pending" } }
        const response = new Promise<CodexServerRequestResult>((resolve) => {
          entry.pending.set(id, {
            ...interaction,
            view: { ...interaction.view, revision: entry.revision + 1 },
            generation: native.generation,
            blocking,
            resolve,
          })
        })
        await emit(entry, { refresh: true }).catch((error) => {
          expireInteractions(entry, (pending) => pending.view.id === id, errorMessage(error))
        })
        await approveAutomatically(entry)
        return { response }
      })
      return registered.response ?? { error: registered.error! }
    }

    function observeSettings(entry: Entry, notification: Received) {
      if (
        notification.method !== "thread/settings/updated" ||
        notification.generation !== entry.generation ||
        notification.sequence <= entry.settingsSequence ||
        !record(notification.params) ||
        !record(notification.params.threadSettings)
      )
        return
      const settings = notification.params.threadSettings as v2.ThreadSettings
      entry.appliedSettings = observedSettings({
        ...settings,
        sandbox: settings.sandboxPolicy,
        reasoningEffort: settings.effort,
      })
      entry.nativeProvider = settings.modelProvider
      entry.settingsSequence = notification.sequence
      // Confirmation can precede an approval and the turn/start response.
      // Never wait for the execution lane before answering that approval.
      scheduleAutomaticApprovals(entry)
    }

    function scheduleAutomaticApprovals(entry: Entry) {
      void serializeInteraction(entry, () => approveAutomatically(entry)).catch((error) => {
        entry.error = errorMessage(error)
        void emit(entry, { refresh: true }).catch(() => undefined)
      })
    }

    async function approveAutomatically(entry: Entry) {
      if (entry.deletionChecks) return
      if (effectiveSettings(entry).permission !== "auto") return
      for (const pending of entry.pending.values()) {
        if (pending.view.state !== "pending" || !["command", "file", "permissions"].includes(pending.view.kind))
          continue
        const choice = pending.view.choices.find((choice) => choice.kind === "allow")
        if (!choice) continue
        await replyPending(
          entry,
          pending.view.id,
          { revision: pending.view.revision, choiceID: choice.id },
          true,
        ).catch((error) => {
          // Keep a failed automatic attempt pending for the existing UI.
          entry.error = errorMessage(error)
        })
      }
    }

    // Both callers hold the interaction lane, including settings changes.
    // Auto only accepts a native one-shot choice; it never creates rule grants.
    async function replyPending(entry: Entry, id: string, input: Reply, automatic = false) {
      if (entry.deletionChecks) {
        if (automatic) return
        return fail("conflict", "Session family deletion is being checked")
      }
      entry.record = await run(sessions.get(entry.record.session.id))
      entry.desiredSettings = decodeSettings(entry.record.binding.settings)
      const connected = state.runtime
      const pending = entry.pending.get(id)
      const valid = () =>
        connected &&
        current(connected) &&
        pending &&
        pending.generation === connected.generation &&
        entry.generation === connected.generation &&
        pending.view.state === "pending" &&
        pending.view.revision === input.revision &&
        !resolvedRequests.has(id) &&
        entry.pending.get(id) === pending &&
        (!automatic || effectiveSettings(entry).permission === "auto")
      if (automatic && (!valid() || unconfirmedExecution(entry))) return
      if (unconfirmedExecution(entry))
        return fail("conflict", "Previous native execution has not been confirmed finished")
      if (!valid()) return fail("conflict", "Native interaction is no longer pending")
      const response = pending!.reply(input)
      await acquire(entry)
      if (automatic && !valid()) return
      if (!valid()) return fail("conflict", "Native interaction is no longer pending")
      entry.record.binding = await run(sessions.setExecutionPending(entry.record.session.id, true))
      if (automatic && !valid()) return
      if (!valid()) return fail("conflict", "Native interaction is no longer pending")
      entry.executionObserved = true
      pending!.view = { ...pending!.view, state: "replying" }
      pending!.resolve(response)
      await emit(entry, { refresh: true })
      dispatch(entry, "interaction-resolved")
    }

    function dispatch(entry: Entry, requestID = "advance", retry = false) {
      if (entry.deletionChecks) return
      void serialize(entry, async () => {
        if (entry.deletionChecks) return
        await (async () => {
          if (retry) {
            const receipt = await run(sessions.getDelivery({ sessionID: entry.record.session.id, requestID }))
            if (!receipt || receipt.state !== "pending") return
            await requireReady(decodeInput(receipt.payload).settings)
            await run(
              worktrees.claim({
                directory: entry.record.session.location.directory,
                sessionID: entry.record.session.id,
              }),
            )
          }
          await pump(entry)
        })().catch(async (error) => {
          entry.error = errorMessage(error)
          await emit(entry, { refresh: true })
        })
      }).catch(() => undefined)
    }

    async function syncTitle(entry: Entry, title?: string | null) {
      const nativeThreadID = entry.record.binding.nativeThreadID
      if (!nativeThreadID) return
      const written = await run(
        sessions.syncTitle({
          sessionID: entry.record.session.id,
          runtimeScope,
          nativeThreadID,
          title: title ?? undefined,
          previousTitle: entry.autoTitle,
        }),
      )
      // Only titles actually written by this Host are owned in memory. After a
      // restart, an existing custom title is preserved without guessed provenance.
      if (written) entry.autoTitle = written
      entry.record = await run(sessions.get(entry.record.session.id))
    }

    async function freeze(input: Input) {
      return json({ ...(await prepareInput(input)), requestFingerprint: fingerprint(input) })
    }

    function retryPayload(delivery: SessionExternal.Delivery, input: Input) {
      const stored = delivery.payload
      const expected =
        record(stored) && typeof stored.requestFingerprint === "string"
          ? stored.requestFingerprint
          : fingerprint(decodeInput(stored))
      if (expected !== fingerprint(input)) return fail("conflict", "Request ID was reused with different input")
      // Exact retries reuse the bytes frozen at admission, even if the original
      // attachment was subsequently modified or removed from disk.
      return stored
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true
        for (const entry of entries.values()) if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
        try {
          if (state.manager) await state.manager.close()
        } finally {
          await credentials.close()
        }
      }),
    )

    return Service.of({
      engines: () =>
        result(async () => {
          if (!enabled) return []
          return [
            await Promise.all([account(), models()])
              .then(
                ([account, models]): Engine => ({
                  id: "codex",
                  available: true,
                  version: CODEX_APP_SERVER_VERSION,
                  account,
                  models,
                  capabilities: supported,
                }),
              )
              .catch(
                (error): Engine => ({
                  id: "codex",
                  available: false,
                  error: errorMessage(error),
                  account: { authenticated: false, requiresAuth: false },
                  models: [],
                  capabilities: disabled,
                }),
              ),
          ]
        }),
      account: () => result(account),
      login: () =>
        result(async () => fail("invalid", "Configure authentication in Providers; Codex has no separate login")),
      cancelLogin: () => result(async () => fail("invalid", "Codex has no separate login")),
      describe: (sessionIDs) =>
        result(async () => {
          const values = await run(sessions.describe(sessionIDs))
          return Promise.all(
            values.map(
              async (value): Promise<Descriptor> =>
                value.binding
                  ? descriptor(await getEntry(value.session.id))
                  : {
                      sessionID: value.session.id,
                      engine: "opencode",
                      epoch,
                      revision: 0,
                      runtimeStatus: "idle",
                      capabilities: disabled,
                      queuePaused: false,
                      settings: {},
                    },
            ),
          )
        }),
      create: (input) =>
        result(async () => {
          const existing = await run(sessions.getCreation(runtimeScope, input.requestID))
          if (
            existing &&
            (existing.delivery.delivery !== input.delivery ||
              fingerprint(existing.session.location) !== fingerprint(input.location))
          )
            return fail("conflict", "Creation request ID was reused with different location or delivery mode")
          const payload = existing ? retryPayload(existing.delivery, input.input) : await freeze(input.input)
          if (!existing) await requireReady(input.input.settings)
          const created = await run(
            sessions.create({
              runtimeScope,
              requestID: input.requestID,
              engine: "codex",
              location: input.location,
              payload,
              settings: json(input.input.settings),
              delivery: input.delivery,
            }),
          )
          const entry = await getEntry(created.session.id)
          if (existing && created.session.time.archived !== undefined)
            return fail("conflict", `Session ${created.session.id} is archived; restore it before retrying input`)
          if (!existing) {
            await run(worktrees.claim({ directory: created.session.location.directory, sessionID: created.session.id }))
            dispatch(entry, input.requestID)
          } else if (created.delivery.state === "pending" && ["pending", "bound"].includes(created.binding.state))
            dispatch(entry, input.requestID, true)
          const deliveries = await run(sessions.deliveries(entry.record.session.id))
          entry.inputWaitReason = inputWaitReason(entry, deliveries)
          return { descriptor: descriptor(entry), delivery: deliveryView(created.delivery, entry, deliveries) }
        }),
      submit: (sessionID, input) =>
        result(async () => {
          const entry = await getEntry(sessionID)
          const existing = await run(sessions.getDelivery({ sessionID, requestID: input.requestID }))
          if (existing && existing.delivery !== input.delivery)
            return fail("conflict", "Request ID was reused with a different delivery mode")
          const payload = existing ? retryPayload(existing, input.input) : await freeze(input.input)
          if (!existing) await requireReady(input.input.settings)
          return serialize(entry, async () => {
            entry.record = await run(sessions.get(sessionID))
            if (!existing && unconfirmedExecution(entry))
              return fail("conflict", "Previous native execution has not been confirmed finished")
            if (!existing && entry.record.binding.state !== "bound")
              return fail("conflict", "Native thread binding is not ready")
            const delivery = await run(
              sessions.admit({ sessionID, requestID: input.requestID, payload, delivery: input.delivery }),
            )
            if (!existing || delivery.state === "pending") dispatch(entry, input.requestID, !!existing)
            const deliveries = await run(sessions.deliveries(entry.record.session.id))
            entry.inputWaitReason = inputWaitReason(entry, deliveries)
            return { descriptor: descriptor(entry), delivery: deliveryView(delivery, entry, deliveries) }
          })
        }),
      snapshot: (sessionID) =>
        result(async () => {
          const entry = await getEntry(sessionID)
          const mode = await serialize(entry, async () => {
            entry.record = await run(sessions.get(sessionID))
            if (entry.record.binding.state !== "bound" || entry.record.binding.deletionState || entry.activating) return
            const stale =
              !entry.native ||
              entry.generation !== state.runtime?.generation ||
              (entry.dirty && !entry.refreshTimer && !entry.refreshPending)
            if (!stale) return
            return entry.resumed ? ("refresh" as const) : ("observe" as const)
          })
          const hydrated =
            mode === "observe"
              ? await refresh(entry, false, false, true)
                  .then((dirty) => !dirty)
                  .catch(async (error) => {
                    await serialize(entry, async () => {
                      entry.status = state.runtime ? "bindingUnavailable" : "disconnected"
                      entry.error = errorMessage(error)
                      entry.dirty = true
                      await emit(entry)
                    })
                    return false
                  })
              : false
          if (mode === "refresh")
            await refresh(entry).catch(async (error) => {
              await serialize(entry, async () => {
                entry.status = state.runtime ? "bindingUnavailable" : "disconnected"
                entry.error = errorMessage(error)
                entry.dirty = true
                await emit(entry)
              })
            })
          if (hydrated || entry.native) scheduleActivation(entry)
          return serialize(entry, () => snapshot(entry))
        }),
      delivery: (sessionID, requestID) =>
        result(async () => {
          const entry = await getEntry(sessionID)
          const item = await run(sessions.getDelivery({ sessionID, requestID }))
          if (!item) return fail("notFound", "Input receipt does not exist")
          const deliveries = await run(sessions.deliveries(sessionID))
          return deliveryView(item, entry, deliveries)
        }),
      queue: (sessionID, input) =>
        result(async () => {
          const entry = await getEntry(sessionID)
          const controlSequence = await serialize(entry, async () => {
            if (input.revision !== entry.revision) return fail("conflict", "Queue changed; refresh before modifying it")
            return entry.controlSequence
          })
          if (input.action === "resume" && (!entry.resumed || entry.dirty)) await refresh(entry, true)
          return serialize(entry, async () => {
            if (controlSequence !== entry.controlSequence)
              return fail("conflict", "Queue changed; refresh before modifying it")
            entry.controlSequence++
            if (input.action === "withdraw") await run(sessions.withdraw({ sessionID, requestID: input.requestID }))
            else {
              entry.record = await run(sessions.get(sessionID))
              if (entry.record.session.time.archived !== undefined)
                return fail("conflict", `Session ${sessionID} is archived; restore it before resuming queued input`)
              const receipt = await run(sessions.getDelivery({ sessionID, requestID: input.requestID }))
              if (!receipt) return fail("notFound", "Input receipt does not exist")
              if (receipt.delivery === "queue" && entry.status !== "idle")
                return fail("conflict", "Native session has not been confirmed idle")
              if (["paused", "returned"].includes(receipt.state))
                await run(sessions.resume({ sessionID, requestID: input.requestID }))
              else if (receipt.state === "pending") await run(sessions.setQueuePaused(sessionID, false))
              else return fail("conflict", "Only pending, paused or returned input may be resumed")
              entry.record = await run(sessions.get(sessionID))
              await pump(entry)
            }
            await emit(entry, { refresh: true })
            return snapshot(entry)
          })
        }),
      interrupt: (sessionID) =>
        result(async () => {
          const entry = await getEntry(sessionID)
          const needsRefresh = await serialize(entry, async () => {
            entry.controlSequence++
            entry.record.binding = await run(sessions.pause(sessionID))
            entry.record = await run(sessions.get(sessionID))
            if (entry.activeTurnID) entry.status = "interrupting"
            await emit(entry, { refresh: true })
            return (
              !entry.activeTurnID && (!entry.resumed || entry.dirty || entry.generation !== state.runtime?.generation)
            )
          })
          const connected = await runtime()
          if (needsRefresh) await refresh(entry, true)
          const target = await serialize(entry, async () => {
            if (!entry.activeTurnID) {
              if (entry.status !== "idle" || !entry.idleConfirmed)
                return fail("conflict", "The active native turn ID is unavailable; no interrupt was sent")
              await emit(entry, { refresh: true })
              return { kind: "idle" as const, descriptor: descriptor(entry) }
            }
            const turnID = entry.activeTurnID
            entry.status = "interrupting"
            await emit(entry)
            return { kind: "active" as const, turnID, threadID: entry.record.binding.nativeThreadID! }
          })
          if (target.kind === "idle") return target.descriptor
          await connected.interruptTurn(target.threadID, target.turnID, { timeoutMs: 10_000 })
          return serialize(entry, async () => {
            if (!current(connected)) return fail("unavailable", "Codex connection changed during interrupt")
            return descriptor(entry)
          })
        }),
      reply: (sessionID, interactionID, input) =>
        result(async () => {
          const entry = await getEntry(sessionID)
          return serializeInteraction(entry, async () => {
            await replyPending(entry, interactionID, input)
            return snapshot(entry)
          })
        }),
      settings: (sessionID, input) =>
        result(async () => {
          await validateSettings(input)
          const entry = await getEntry(sessionID)
          return serializeInteraction(entry, async () => {
            entry.record = await run(sessions.get(sessionID))
            entry.record.binding = await run(sessions.setSettings(sessionID, json(input)))
            entry.desiredSettings = decodeSettings(entry.record.binding.settings)
            await approveAutomatically(entry)
            if (!entry.resumed && entry.native && entry.status === "bindingUnavailable") scheduleActivation(entry)
            await emit(entry)
            return descriptor(entry)
          })
        }),
      remove: (sessionID) =>
        result(async () => {
          const root = await getEntry(sessionID)
          const checked = new Set<Entry>()
          const hold = (entry: Entry) => {
            if (checked.has(entry)) return entry
            checked.add(entry)
            entry.deletionChecks++
            if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
            entry.refreshTimer = undefined
            return entry
          }
          hold(root)
          try {
            if (!root.record.binding.deletionState) {
              await refresh(root, false, false).catch((error) => {
                if (!nativeThreadMissing(error, root.record.binding.nativeThreadID)) throw error
                return fail("conflict", "The bound native thread could not be found; the Session was preserved")
              })
              await resolveKnownFamily(root)
            }
            const family = await run(sessions.family(sessionID))
            const entriesInFamily = await Promise.all(
              family.records.map(async (record) => hold(await getEntry(record.session.id))),
            )
            if (!family.records.some((record) => record.binding.deletionState)) {
              for (const entry of entriesInFamily) {
                if (entry.record.binding.nativeThreadID) await refresh(entry, false, false)
              }
            }
            await Promise.all(
              entriesInFamily.flatMap((entry) =>
                [entry.refreshing, entry.activating].filter((value) => value !== undefined),
              ),
            )
            return await serializeFamily(entriesInFamily, async () => {
              const latest = await run(sessions.family(sessionID))
              if (!sameSessionIDs(family.records, latest.records))
                return fail("conflict", "Session family changed while deletion was starting")
              const byID = new Map(entriesInFamily.map((entry) => [entry.record.session.id, entry]))
              latest.records.forEach((record) => {
                const entry = byID.get(record.session.id)
                if (entry) entry.record = record
              })
              const connected = latest.records.some((record) => record.binding.nativeThreadID)
                ? await runtime()
                : undefined
              const observed = receiveSequence
              const absent = new Set<SessionSchema.ID>()
              for (const record of latest.records) {
                const entry = byID.get(record.session.id)!
                if (record.binding.runtimeScope !== runtimeScope)
                  return fail("conflict", "A native child belongs to another Codex storage scope")
                if (entry.refreshPending || entry.activeTurnID || entry.activeTools.size || entry.lease)
                  return fail("conflict", "Session family execution is active; stop it before deleting")
                if ([...entry.pending.values()].some((pending) => ["pending", "replying"].includes(pending.view.state)))
                  return fail("conflict", "Session family has a pending native interaction")
                if (record.binding.executionPending)
                  return fail(
                    "conflict",
                    `Native execution for ${record.session.id} has not been confirmed idle; the Session family was preserved`,
                  )
                if (record.binding.deletionState === "confirmed") {
                  absent.add(record.session.id)
                  continue
                }
                if (unstartedBinding(record.binding)) continue
                if (record.binding.state !== "bound" || !record.binding.nativeThreadID)
                  return fail("conflict", "A native Session binding is unresolved; the Session family was preserved")
                const metadata = await connected!
                  .readThread(record.binding.nativeThreadID, false, { timeoutMs: 15_000 })
                  .catch((error) => {
                    if (!record.binding.deletionState || !nativeThreadMissing(error, record.binding.nativeThreadID))
                      throw error
                    absent.add(record.session.id)
                    return undefined
                  })
                if (!metadata) continue
                if (metadata.thread.id !== record.binding.nativeThreadID)
                  return fail("conflict", "Codex returned a different native thread during deletion")
                if (!["idle", "notLoaded"].includes(metadata.thread.status.type))
                  return fail("conflict", "Session family execution is active; stop it before deleting")
                if (
                  !(await run(
                    ownership.confirmIdle({
                      runtimeScope,
                      generation: generation(connected!),
                      sessionID: record.session.id,
                    }),
                  ))
                )
                  return fail("unavailable", "Codex connection changed while confirming deletion safety")
              }
              if (
                latest.records.some(
                  (record) =>
                    record.binding.nativeThreadID && (signals.get(record.binding.nativeThreadID) ?? 0) > observed,
                )
              )
                return fail("conflict", "Session family changed while deletion was being checked")
              const token =
                latest.root.binding.deletionGeneration ??
                (connected ? generation(connected) : `${epoch}:unstarted:${randomUUID()}`)
              const bindings = await run(
                sessions.beginDelete({
                  rootID: sessionID,
                  sessionIDs: latest.records.map((record) => record.session.id),
                  generation: token,
                }),
              )
              bindings.forEach((binding) => {
                const entry = byID.get(binding.sessionID)
                if (entry) entry.record.binding = binding
              })
              await Promise.all(entriesInFamily.map((entry) => emit(entry, { refresh: true })))
              const bindingByID = new Map(bindings.map((binding) => [binding.sessionID, binding]))
              for (const record of latest.records) {
                const binding = bindingByID.get(record.session.id)!
                if (binding.nativeThreadID && !absent.has(record.session.id)) continue
                bindingByID.set(
                  record.session.id,
                  await run(sessions.markDeleteConfirmed({ sessionID: record.session.id, generation: token })),
                )
              }
              try {
                await run(worktrees.prepareDelete(sessionID))
              } catch (error) {
                const message = errorMessage(error)
                await Promise.all(
                  [...bindingByID.values()]
                    .filter((value) => value.deletionState !== "confirmed")
                    .map(async (member) => {
                      const binding = await run(
                        sessions.markDeleteUnknown({ sessionID: member.sessionID, generation: token, error: message }),
                      )
                      bindingByID.set(member.sessionID, binding)
                      const entry = byID.get(member.sessionID)
                      if (entry) {
                        entry.record.binding = binding
                        await emit(entry, { refresh: true })
                      }
                    }),
                )
                return fail("conflict", message)
              }
              const postorder = [...latest.records].reverse()
              for (const record of postorder) {
                const binding = bindingByID.get(record.session.id)!
                if (!binding.nativeThreadID || absent.has(record.session.id)) continue
                try {
                  await connected!.deleteThread(binding.nativeThreadID, { timeoutMs: 15_000 })
                  bindingByID.set(
                    record.session.id,
                    await run(sessions.markDeleteConfirmed({ sessionID: record.session.id, generation: token })),
                  )
                } catch (error) {
                  if (nativeThreadMissing(error, binding.nativeThreadID)) {
                    bindingByID.set(
                      record.session.id,
                      await run(sessions.markDeleteConfirmed({ sessionID: record.session.id, generation: token })),
                    )
                    continue
                  }
                  await Promise.all(
                    [...bindingByID.values()]
                      .filter((value) => value.deletionState !== "confirmed")
                      .map(async (member) => {
                        const binding = await run(
                          sessions.markDeleteUnknown({
                            sessionID: member.sessionID,
                            generation: token,
                            error: errorMessage(error),
                          }),
                        )
                        bindingByID.set(member.sessionID, binding)
                        const entry = byID.get(member.sessionID)
                        if (entry) {
                          entry.record.binding = binding
                          await emit(entry, { refresh: true })
                        }
                      }),
                  )
                  return fail(error instanceof CodexRpcError ? "conflict" : "unavailable", errorMessage(error))
                }
              }
              await Promise.all(entriesInFamily.map((entry) => release(entry)))
              for (const record of postorder) {
                const entry = byID.get(record.session.id)
                if (entry?.refreshTimer) clearTimeout(entry.refreshTimer)
                if (entry) entry.refreshTimer = undefined
                await run(sessions.completeDelete({ sessionID: record.session.id, generation: token }))
                entries.delete(record.session.id)
                if (record.binding.nativeThreadID) nativeSessions.delete(record.binding.nativeThreadID)
              }
              await run(worktrees.finalizeDelete(sessionID)).catch((error) => fail("conflict", errorMessage(error)))
            })
          } finally {
            checked.forEach((entry) => {
              entry.deletionChecks--
              if (entry.deletionChecks === 0 && entry.dirty && entries.get(entry.record.session.id) === entry)
                scheduleRefresh(entry)
            })
          }
        }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    KomaInstructions.node,
    Global.node,
    SessionExternal.node,
    SessionExternalOwnership.node,
    CodexWorktreeAccess.node,
    CodexProviders.node,
    EventV2.node,
  ],
})

function emptyView(): CodexView {
  return {
    messages: [],
    messageOrder: [],
    partOrder: {},
    usage: { status: "unavailable" },
    contextWindow: { status: "unavailable" },
    cost: { status: "unavailable" },
    turnDiffs: {},
    sessionDiff: { status: "unavailable" },
    identities: { sourceKeyByMessageID: {}, unmatchedRolloutKeys: [], unmatchedKeys: [] },
    nativeChildren: [],
  }
}

function deliveryView(
  input: SessionExternal.Delivery,
  entry?: Entry,
  deliveries: SessionExternal.Delivery[] = [],
): Delivery {
  return {
    sessionID: input.sessionID,
    requestID: input.requestID,
    state: input.state,
    delivery: input.delivery,
    input: decodeInput(input.payload),
    nativeTurnID: input.nativeTurnID,
    nativeItemID: input.nativeItemID,
    waitReason: entry ? deliveryWaitReason(entry, input, deliveries) : undefined,
    error: input.error,
    createdAt: input.created,
  }
}

function deliveryWaitReason(
  entry: Entry,
  input: SessionExternal.Delivery,
  deliveries: SessionExternal.Delivery[],
): InputWaitReason | undefined {
  if (input.state === "paused") return "paused"
  if (input.state === "unknown") return "deliveryUnknown"
  if (input.state === "accepted" && !input.nativeItemID) return "nativeConfirmation"
  if (input.state !== "pending") return
  if (
    deliveries.some(
      (delivery) =>
        delivery.state === "pending" && delivery.delivery === input.delivery && delivery.sequence < input.sequence,
    )
  )
    return "earlierInput"
  const status = interactionStatus(entry)
  if (status === "waitingApproval") return "waitingApproval"
  if (status === "waitingInput") return "waitingInput"
  if (input.delivery === "queue" && entry.record.binding.queuePaused) return "paused"
  if (input.delivery === "queue" && status !== "idle") return "waitingForIdle"
  if (entry.inputWaitReason === "waitingForConfiguration") return "waitingForConfiguration"
  if (!["idle", "active"].includes(status)) return "waitingForIdle"
}

function inputWaitReason(entry: Entry, deliveries: SessionExternal.Delivery[]): InputWaitReason | undefined {
  const pending = deliveries.filter((delivery) => delivery.state === "pending")
  const next = pending.find((delivery) => delivery.delivery === "steer") ?? pending[0]
  if (next) return deliveryWaitReason(entry, next, deliveries)
  if (deliveries.some((delivery) => delivery.state === "unknown")) return "deliveryUnknown"
  if (deliveries.some((delivery) => delivery.state === "paused")) return "paused"
  if (deliveries.some((delivery) => delivery.state === "accepted" && !delivery.nativeItemID))
    return "nativeConfirmation"
}

function nativeStatus(status: v2.ThreadStatus): RuntimeStatus {
  if (status.type === "idle") return "idle"
  if (status.type === "notLoaded") return "disconnected"
  if (status.type === "systemError") return "systemError"
  if (status.activeFlags.includes("waitingOnApproval")) return "waitingApproval"
  if (status.activeFlags.includes("waitingOnUserInput")) return "waitingInput"
  return "active"
}

function itemKey(turnID: string, itemID: string) {
  return `${turnID.length}:${turnID}:${itemID}`
}

function interactionStatus(entry: Entry): RuntimeStatus {
  const pending = [...entry.pending.values()].find((pending) => pending.blocking && pending.view.state === "pending")
  if (!pending) return entry.status
  return ["question", "form", "url"].includes(pending.view.kind) ? "waitingInput" : "waitingApproval"
}

function unconfirmedExecution(entry: Entry) {
  return entry.record.binding.executionPending && !entry.executionObserved
}

function unstartedBinding(binding: SessionExternal.Binding) {
  return binding.state === "pending" && !binding.executionPending
}

function sameSessionIDs(left: SessionExternal.Record[], right: SessionExternal.Record[]) {
  const ids = new Set(left.map((record) => record.session.id))
  return left.length === right.length && right.every((record) => ids.has(record.session.id))
}

function nativeThreadMissing(error: unknown, threadID?: string) {
  if (!threadID) return false
  const prefix = "no rollout found for thread id "
  return (
    error instanceof CodexRpcError &&
    error.code === -32600 &&
    error.message.startsWith(prefix) &&
    error.message.slice(prefix.length).trim() === threadID
  )
}

function runningTool(item: unknown): item is v2.ThreadItem & { status: "inProgress" } {
  return record(item) && item.status === "inProgress" && typeof item.id === "string"
}

function observeTool(entry: Entry, notification: CodexServerNotification) {
  if (
    !record(notification.params) ||
    !record(notification.params.item) ||
    typeof notification.params.turnId !== "string" ||
    typeof notification.params.item.id !== "string"
  )
    return false
  const params = notification.params
  const key = itemKey(params.turnId as string, (params.item as Record<string, unknown>).id as string)
  if (notification.method === "item/started" && runningTool(params.item)) {
    entry.activeTools.set(key, { turnID: params.turnId as string, generation: notification.generation })
    entry.idleConfirmed = false
    return true
  }
  if (notification.method === "item/completed" && entry.activeTools.has(key)) {
    entry.activeTools.delete(key)
    return true
  }
  return false
}

function executionStatus(entry: Entry, status: RuntimeStatus, interrupted = false): RuntimeStatus {
  if (unconfirmedExecution(entry)) return "disconnected"
  if (status !== "idle" || !entry.activeTools.size) return status
  return interrupted || entry.status === "interrupting" || entry.native?.turns.at(-1)?.status === "interrupted"
    ? "interrupting"
    : "active"
}

function pendingSettings(entry: Entry, applied: Settings): Settings | undefined {
  const desired = entry.desiredSettings
  return (Object.keys(desired) as Array<keyof Settings>).some(
    (key) => desired[key] !== undefined && desired[key] !== applied[key],
  )
    ? desired
    : undefined
}

function mutableView(view: CodexView): MutableView {
  return { ...view, messages: [...view.messages] }
}

function mergeViews(base: CodexView, live: CodexView): CodexView {
  return {
    ...base,
    messages: [...base.messages, ...live.messages],
    messageOrder: [...base.messageOrder, ...live.messageOrder],
    partOrder: { ...base.partOrder, ...live.partOrder },
    usage: live.usage.status === "available" ? live.usage : base.usage,
    contextWindow: live.contextWindow.status === "available" ? live.contextWindow : base.contextWindow,
    contextTokens: live.contextTokens?.status === "available" ? live.contextTokens : base.contextTokens,
    turnDiffs: { ...base.turnDiffs, ...live.turnDiffs },
    identities: {
      sourceKeyByMessageID: { ...base.identities.sourceKeyByMessageID, ...live.identities.sourceKeyByMessageID },
      unmatchedKeys: [...base.identities.unmatchedKeys, ...live.identities.unmatchedKeys],
      unmatchedRolloutKeys: [...base.identities.unmatchedRolloutKeys, ...live.identities.unmatchedRolloutKeys],
    },
    nativeChildren: [...base.nativeChildren, ...live.nativeChildren],
  }
}

function observedSettings(
  value: Pick<
    v2.ThreadStartResponse,
    "model" | "modelProvider" | "reasoningEffort" | "approvalPolicy" | "approvalsReviewer" | "sandbox" | "cwd"
  >,
): Settings {
  const sandbox = value.sandbox
  const permission =
    value.approvalsReviewer !== "user"
      ? undefined
      : sandbox.type === "dangerFullAccess" && value.approvalPolicy === "never"
        ? "full"
        : sandbox.type === "readOnly" && sandbox.networkAccess === false && value.approvalPolicy === "on-request"
          ? "readOnly"
          : sandbox.type === "workspaceWrite" &&
              sandbox.networkAccess === false &&
              // Native workspaceWrite already includes cwd. Version 0.153.4
              // normalizes that implicit root to an empty writableRoots list.
              (sandbox.writableRoots.length === 0 ||
                (sandbox.writableRoots.length === 1 && sandbox.writableRoots[0] === value.cwd)) &&
              sandbox.excludeTmpdirEnvVar === false &&
              sandbox.excludeSlashTmp === false &&
              value.approvalPolicy === "on-request"
            ? "default"
            : undefined
  return {
    model: CodexProviders.observedModel(value.model, value.modelProvider),
    effort: value.reasoningEffort ?? undefined,
    permission,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function resolveBinary(home: string) {
  const configured = process.env.OPENCODE_CODEX_BINARY
  const candidates = configured
    ? [configured]
    : [
        ...(process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(directory, "codex")),
        path.join(home, ".local", "bin", "codex"),
      ]
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate
  }
  throw new HostError({ code: "unavailable", message: `Codex ${CODEX_APP_SERVER_VERSION} executable was not found` })
}

function changedMessages(before: readonly Message[], after: readonly Message[]) {
  const old = new Map(before.map((message) => [message.id, message]))
  return after.filter((message) => JSON.stringify(old.get(message.id)) !== JSON.stringify(message))
}

function textAppend(
  before: readonly Message[],
  after: readonly Message[],
): Schema.Schema.Type<typeof Changed.data>["append"] {
  if (before.length !== after.length) return
  const changed = changedMessages(before, after)
  if (changed.length !== 1 || changed[0].type !== "assistant") return
  const message = changed[0]
  const old = before.find((item) => item.id === message.id)
  if (old?.type !== "assistant" || old.content.length !== message.content.length) return
  const changedParts = message.content.flatMap((part, index) =>
    JSON.stringify(part) === JSON.stringify(old.content[index]) ? [] : [index],
  )
  if (changedParts.length !== 1) return
  const index = changedParts[0]
  const left = old.content[index],
    right = message.content[index]
  if (
    (left.type !== "text" && left.type !== "reasoning") ||
    right.type !== left.type ||
    right.id !== left.id ||
    !right.text.startsWith(left.text)
  )
    return
  if (JSON.stringify({ ...left, text: "" }) !== JSON.stringify({ ...right, text: "" })) return
  return { messageID: message.id, partID: right.id, type: right.type, delta: right.text.slice(left.text.length) }
}

function applyNotification(entry: Entry, notification: CodexServerNotification) {
  if (!entry.native || !record(notification.params)) return
  const params = notification.params
  if ((notification.method === "turn/started" || notification.method === "turn/completed") && record(params.turn)) {
    const turn = params.turn as v2.Turn
    const found = entry.native.turns.findIndex((item) => item.id === turn.id)
    if (found < 0) entry.native.turns.push(turn)
    else
      entry.native.turns[found] = {
        ...entry.native.turns[found],
        ...turn,
        // Summary turn notifications omit user/tool items. Only full history
        // is authoritative enough to replace the ordered item stream.
        items:
          turn.itemsView === "full"
            ? turn.items
            : [
                ...entry.native.turns[found].items.map(
                  (item) => turn.items.find((value) => value.id === item.id) ?? item,
                ),
                ...turn.items.filter((item) => !entry.native!.turns[found].items.some((value) => value.id === item.id)),
              ],
      }
    return
  }
  if (notification.method === "thread/tokenUsage/updated") {
    entry.usage = params.tokenUsage as v2.ThreadTokenUsage
    return
  }
  if (
    notification.method === "turn/diff/updated" &&
    typeof params.turnId === "string" &&
    typeof params.diff === "string"
  ) {
    entry.diffs[params.turnId] = { status: "available", value: params.diff }
    return
  }
  const turn = entry.native.turns.find((turn) => turn.id === params.turnId)
  if (!turn) return
  if ((notification.method === "item/started" || notification.method === "item/completed") && record(params.item)) {
    const item = params.item as v2.ThreadItem
    const found = turn.items.findIndex((value) => value.id === item.id)
    if (found < 0) turn.items.push(item)
    else turn.items[found] = item
    return
  }
  const item = turn.items.find((item) => item.id === params.itemId)
  if (item) applyItemNotification(item, notification)
}

function applyItemNotification(item: v2.ThreadItem, notification: CodexServerNotification) {
  if (!record(notification.params)) return
  const params = notification.params
  const delta = typeof params.delta === "string" ? params.delta : ""
  if (item.type === "agentMessage" && notification.method === "item/agentMessage/delta") item.text += delta
  if (item.type === "plan" && notification.method === "item/plan/delta") item.text += delta
  if (item.type === "commandExecution" && notification.method === "item/commandExecution/outputDelta")
    item.aggregatedOutput = (item.aggregatedOutput ?? "") + delta
  if (
    item.type === "fileChange" &&
    notification.method === "item/fileChange/patchUpdated" &&
    Array.isArray(params.changes)
  )
    item.changes = params.changes as v2.FileUpdateChange[]
  if (item.type === "reasoning" && notification.method === "item/reasoning/summaryTextDelta") {
    const index = typeof params.summaryIndex === "number" ? params.summaryIndex : 0
    item.summary[index] = (item.summary[index] ?? "") + delta
  }
  if (item.type === "reasoning" && notification.method === "item/reasoning/textDelta") {
    const index = typeof params.contentIndex === "number" ? params.contentIndex : 0
    item.content[index] = (item.content[index] ?? "") + delta
  }
}

function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : record(input)
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .filter((key) => input[key] !== undefined)
              .map((key) => [key, canonical(input[key])]),
          )
        : input
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
}

async function sameDirectory(left: string, right: string) {
  if (left === right) return true
  // Native Codex canonicalizes cwd (for example /var -> /private/var on macOS).
  // Keep the session's chosen path; only compare existing filesystem identities.
  return Promise.all([realpath(left), realpath(right)])
    .then(([a, b]) => a === b)
    .catch(() => false)
}
