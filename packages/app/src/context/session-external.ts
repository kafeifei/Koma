import {
  OpenCode,
  type LabDescribeOutput,
  type LabEnginesOutput,
  type LabSnapshotOutput,
  type OpenCodeEvent,
} from "@opencode-ai/lab-client"
import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  compareExternalVersion,
  projectExternalMessages,
  type ExternalMessageAvailability,
  type ExternalMessageProjection,
  type ExternalWireMessage,
} from "@/utils/session-external"

type Descriptor = LabDescribeOutput[number]
type ChangedEvent = Extract<OpenCodeEvent, { type: "session.external.changed" }>
type EngineChangedEvent = Extract<OpenCodeEvent, { type: "session.external.engine.changed" }>
type ExternalEvent = Pick<ChangedEvent, "type" | "data"> | Pick<EngineChangedEvent, "type" | "data">
type RequestFence = { observed: Descriptor | undefined }

export type SessionExternalCacheTarget = {
  descriptor(descriptor: Descriptor): void
  snapshot(snapshot: LabSnapshotOutput, projection: ExternalMessageProjection): void
  projection(sessionID: string, projection: ExternalMessageProjection): void
  append(input: { sessionID: string; messageID: string; partID: string; delta: string }): boolean
}

export function isSessionExternalEvent(event: {
  type: string
}): event is { type: "session.external.changed" | "session.external.engine.changed" } {
  return event.type === "session.external.changed" || event.type === "session.external.engine.changed"
}

export function createSessionExternalContext(input: {
  api: ReturnType<typeof OpenCode.make>["lab"]
  target: () => SessionExternalCacheTarget
}) {
  const [data, setData] = createStore({
    support: "unknown" as "unknown" | "available" | "unsupported",
    engines: undefined as LabEnginesOutput | undefined,
    descriptors: {} as Record<string, Descriptor | undefined>,
    snapshots: {} as Record<string, LabSnapshotOutput | undefined>,
    messageAvailability: {} as Record<string, Record<string, ExternalMessageAvailability> | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    errors: {} as Record<string, string | undefined>,
  })
  const hints = new Map<string, "opencode" | "codex">()
  const snapshots = new Map<string, Promise<LabSnapshotOutput>>()
  const refreshAfterSnapshot = new Set<string>()
  const retiredEpochs = new Map<string, Set<string>>()

  const unsupported = (error: unknown) => {
    if (!isStatus(error, 404)) return false
    setData("support", "unsupported")
    setData("engines", reconcile([]))
    return true
  }

  const responseAllowed = (descriptor: Descriptor, fence?: RequestFence) => {
    if (retiredEpochs.get(descriptor.sessionID)?.has(descriptor.epoch)) return false
    if (!fence) return true
    const current = data.descriptors[descriptor.sessionID]
    if (!current || current.epoch === descriptor.epoch) return true
    if (!fence.observed) return false
    return current.epoch === fence.observed.epoch && current.revision === fence.observed.revision
  }

  const matchesFence = (sessionID: string, fence: RequestFence) => {
    const current = data.descriptors[sessionID]
    if (!current || !fence.observed) return current === fence.observed
    return current.epoch === fence.observed.epoch && current.revision === fence.observed.revision
  }

  const commitDescriptor = (descriptor: Descriptor, fence?: RequestFence) => {
    if (!responseAllowed(descriptor, fence)) return
    const current = data.descriptors[descriptor.sessionID]
    const decision = compareExternalVersion(current, descriptor)
    if (decision === "duplicate" && current) return current
    if (current && current.epoch !== descriptor.epoch) {
      const epochs = retiredEpochs.get(descriptor.sessionID) ?? new Set<string>()
      epochs.add(current.epoch)
      retiredEpochs.set(descriptor.sessionID, epochs)
    }
    setData("support", "available")
    setData("descriptors", descriptor.sessionID, reconcile(descriptor))
    hints.set(descriptor.sessionID, descriptor.engine)
    if (descriptor.engine === "codex") input.target().descriptor(descriptor)
    const snapshot = data.snapshots[descriptor.sessionID]
    if (snapshot) setData("snapshots", descriptor.sessionID, reconcile({ ...snapshot, descriptor }))
    return descriptor
  }

  const commitSnapshot = (snapshot: LabSnapshotOutput, fence?: RequestFence) => {
    if (!responseAllowed(snapshot.descriptor, fence)) return false
    const current = data.descriptors[snapshot.descriptor.sessionID]
    if (current && current.epoch === snapshot.descriptor.epoch && current.revision > snapshot.descriptor.revision) {
      return false
    }
    const projection = projectExternalMessages({
      sessionID: snapshot.descriptor.sessionID,
      messages: snapshot.messages,
      messageOrder: snapshot.messageOrder,
      partOrder: snapshot.partOrder,
    })
    batch(() => {
      commitDescriptor(snapshot.descriptor)
      setData("snapshots", snapshot.descriptor.sessionID, reconcile(snapshot))
      setData("messageAvailability", snapshot.descriptor.sessionID, reconcile(projection.availability))
      setData("errors", snapshot.descriptor.sessionID, undefined)
      input.target().snapshot(snapshot, projection)
    })
    return true
  }

  const loadSnapshot = (sessionID: string, options?: { force?: boolean; retryStale?: boolean }) => {
    const cached = data.snapshots[sessionID]
    if (cached && !options?.force) return Promise.resolve(cached)
    const pending = snapshots.get(sessionID)
    if (pending) {
      if (options?.force) refreshAfterSnapshot.add(sessionID)
      return pending
    }
    setData("loading", sessionID, true)
    const fence = { observed: data.descriptors[sessionID] }
    const request = input.api.snapshot({ sessionID })
    const promise = request
      .then((snapshot) => {
        if (!commitSnapshot(snapshot, fence) && options?.retryStale !== false) refreshAfterSnapshot.add(sessionID)
        return snapshot
      })
      .catch((error) => {
        if (matchesFence(sessionID, fence)) setData("errors", sessionID, errorMessage(error))
        throw error
      })
      .finally(() => {
        if (snapshots.get(sessionID) !== promise) return
        snapshots.delete(sessionID)
        setData("loading", sessionID, false)
        if (!refreshAfterSnapshot.delete(sessionID)) return
        void loadSnapshot(sessionID, { force: true, retryStale: false }).catch(() => undefined)
      })
    snapshots.set(sessionID, promise)
    return promise
  }

  const describe = async (sessionIDs: readonly string[]) => {
    const unique = [...new Set(sessionIDs)]
    if (!unique.length || data.support === "unsupported") return []
    const fences = new Map(unique.map((sessionID) => [sessionID, { observed: data.descriptors[sessionID] }]))
    try {
      const descriptors = await input.api.describe({ sessionIDs: unique })
      batch(() => descriptors.forEach((descriptor) => commitDescriptor(descriptor, fences.get(descriptor.sessionID))))
      return descriptors.flatMap((descriptor) => {
        const current = data.descriptors[descriptor.sessionID]
        return current ? [current] : []
      })
    } catch (error) {
      if (unsupported(error)) return []
      throw error
    }
  }

  const ensureDescriptor = async (sessionID: string) => {
    const current = data.descriptors[sessionID]
    if (current) return current
    if (data.support === "unsupported") return
    await describe([sessionID])
    return data.descriptors[sessionID]
  }

  const load = async (sessionID: string, options?: { force?: boolean }) => {
    const hinted = hints.get(sessionID)
    const descriptor = data.descriptors[sessionID] ?? (hinted ? undefined : await ensureDescriptor(sessionID))
    const engine = descriptor?.engine ?? hinted ?? (data.support === "unsupported" ? "opencode" : undefined)
    if (engine === "opencode") return false
    if (!engine) throw new Error(`Session engine is unavailable: ${sessionID}`)
    await loadSnapshot(sessionID, options)
    return true
  }

  const refreshEngines = async () => {
    if (data.support === "unsupported") return []
    try {
      const engines = await input.api.engines()
      batch(() => {
        setData("support", "available")
        setData("engines", reconcile(engines))
      })
      return engines
    } catch (error) {
      if (unsupported(error)) return []
      throw error
    }
  }

  const applyMessages = (event: Extract<ExternalEvent, { type: "session.external.changed" }>) => {
    if (!event.data.messages?.length) return
    const snapshot = data.snapshots[event.data.sessionID]
    const messages = new Map<string, ExternalWireMessage>(snapshot?.messages.map((message) => [message.id, message]))
    event.data.messages.forEach((message) => messages.set(message.id, message))
    const messageOrder = [
      ...(snapshot?.messageOrder ?? []),
      ...event.data.messages.flatMap((message) => (snapshot?.messageOrder.includes(message.id) ? [] : [message.id])),
    ]
    const values = messageOrder.flatMap((id) => {
      const message = messages.get(id)
      return message ? [message] : []
    })
    const partOrder = {
      ...snapshot?.partOrder,
      ...Object.fromEntries(
        event.data.messages.flatMap((message) =>
          message.type === "assistant" ? [[message.id, message.content.map((content) => content.id)] as const] : [],
        ),
      ),
    }
    const projection = projectExternalMessages({
      sessionID: event.data.sessionID,
      messages: values,
      messageOrder,
      partOrder,
    })
    batch(() => {
      if (snapshot) {
        setData(
          "snapshots",
          event.data.sessionID,
          reconcile({
            ...snapshot,
            messages: values as LabSnapshotOutput["messages"],
            messageOrder,
            partOrder,
          }),
        )
      }
      setData("messageAvailability", event.data.sessionID, reconcile(projection.availability))
      input.target().projection(event.data.sessionID, projection)
    })
  }

  const applyAppend = (event: Extract<ExternalEvent, { type: "session.external.changed" }>) => {
    const append = event.data.append
    if (!append) return true
    const applied = input.target().append({ sessionID: event.data.sessionID, ...append })
    const snapshot = data.snapshots[event.data.sessionID]
    if (!snapshot) return applied
    const messageIndex = snapshot.messages.findIndex((message) => message.id === append.messageID)
    const message = snapshot.messages[messageIndex]
    if (!message || message.type !== "assistant") return false
    const contentIndex = message.content.findIndex(
      (content) => content.id === append.partID && content.type === append.type,
    )
    const content = message.content[contentIndex]
    if (!content || (content.type !== "text" && content.type !== "reasoning")) return false
    const contents = message.content.map((item, index) =>
      index === contentIndex && (item.type === "text" || item.type === "reasoning")
        ? { ...item, text: item.text + append.delta }
        : item,
    )
    const messages = snapshot.messages.map((item, index) =>
      index === messageIndex ? { ...message, content: contents } : item,
    )
    setData("snapshots", event.data.sessionID, reconcile({ ...snapshot, messages } as LabSnapshotOutput))
    return applied
  }

  const apply = (event: ExternalEvent) => {
    if (event.type === "session.external.engine.changed") {
      if (data.support === "unsupported") setData("support", "unknown")
      void refreshEngines().catch(() => undefined)
      return
    }
    const current = data.descriptors[event.data.sessionID]
    const decision = compareExternalVersion(current, event.data)
    if (decision === "duplicate") return
    if (decision === "gap" || decision === "epoch" || event.data.refresh) {
      if (event.data.descriptor) commitDescriptor(event.data.descriptor)
      void loadSnapshot(event.data.sessionID, { force: true }).catch(() => undefined)
      return
    }
    if (!current && !event.data.descriptor) {
      void loadSnapshot(event.data.sessionID, { force: true }).catch(() => undefined)
      return
    }
    const descriptor =
      event.data.descriptor ??
      (current && {
        ...current,
        epoch: event.data.epoch,
        revision: event.data.revision,
      })
    if (descriptor) commitDescriptor(descriptor)
    applyMessages(event)
    if (!applyAppend(event)) void loadSnapshot(event.data.sessionID, { force: true }).catch(() => undefined)
  }

  const accepted = (receipt: Awaited<ReturnType<typeof input.api.create>>, fence: RequestFence) => {
    const committed = commitDescriptor(receipt.descriptor, fence)
    if (
      !committed ||
      committed.epoch !== receipt.descriptor.epoch ||
      committed.revision !== receipt.descriptor.revision
    ) {
      void loadSnapshot(receipt.descriptor.sessionID, { force: true }).catch(() => undefined)
      return receipt
    }
    const snapshot = data.snapshots[receipt.descriptor.sessionID]
    if (snapshot) {
      const deliveries = [
        ...snapshot.deliveries.filter((item) => item.requestID !== receipt.delivery.requestID),
        receipt.delivery,
      ]
      setData("snapshots", receipt.descriptor.sessionID, reconcile({ ...snapshot, deliveries }))
    }
    void loadSnapshot(receipt.descriptor.sessionID, { force: true }).catch(() => undefined)
    return receipt
  }

  const commitAccount = (account: Awaited<ReturnType<typeof input.api.account>>) => {
    if (data.engines) {
      setData(
        "engines",
        reconcile(data.engines.map((engine) => (engine.id === "codex" ? { ...engine, account } : engine))),
      )
    }
    return account
  }

  return {
    data,
    observe(sessions: readonly { id: string; engine?: "opencode" | "codex" }[]) {
      sessions.forEach((session) => {
        if (session.engine) hints.set(session.id, session.engine)
      })
    },
    engine(sessionID: string) {
      return (
        data.descriptors[sessionID]?.engine ??
        hints.get(sessionID) ??
        (data.support === "unsupported" ? "opencode" : undefined)
      )
    },
    isExternal(sessionID: string) {
      return (data.descriptors[sessionID]?.engine ?? hints.get(sessionID)) === "codex"
    },
    loading(sessionID: string) {
      return data.loading[sessionID] ?? false
    },
    describe,
    load,
    refreshEngines,
    reconnect() {
      if (data.support === "unsupported") setData("support", "unknown")
    },
    apply,
    actions: {
      account: () => input.api.account().then(commitAccount),
      login: () => input.api.login(),
      cancelLogin: (loginID: string) => input.api.cancelLogin({ loginID }).then(commitAccount),
      create: (request: Parameters<typeof input.api.create>[0]) => {
        const fence = { observed: undefined }
        return input.api.create(request).then((receipt) => accepted(receipt, fence))
      },
      submit: (request: Parameters<typeof input.api.submit>[0]) => {
        const fence = { observed: data.descriptors[request.sessionID] }
        return input.api.submit(request).then((receipt) => accepted(receipt, fence))
      },
      delivery: async (request: Parameters<typeof input.api.delivery>[0]) => {
        const fence = { observed: data.descriptors[request.sessionID] }
        const delivery = await input.api.delivery(request)
        if (!matchesFence(request.sessionID, fence)) return delivery
        const snapshot = data.snapshots[request.sessionID]
        if (snapshot) {
          const deliveries = [...snapshot.deliveries.filter((item) => item.requestID !== delivery.requestID), delivery]
          setData("snapshots", request.sessionID, reconcile({ ...snapshot, deliveries }))
        }
        return delivery
      },
      queue: async (request: Parameters<typeof input.api.queue>[0]) => {
        const fence = { observed: data.descriptors[request.sessionID] }
        const snapshot = await input.api.queue(request)
        commitSnapshot(snapshot, fence)
        return snapshot
      },
      interrupt: async (sessionID: string) => {
        const fence = { observed: data.descriptors[sessionID] }
        const descriptor = await input.api.interrupt({ sessionID })
        commitDescriptor(descriptor, fence)
        void loadSnapshot(sessionID, { force: true }).catch(() => undefined)
        return descriptor
      },
      reply: async (request: Parameters<typeof input.api.reply>[0]) => {
        const fence = { observed: data.descriptors[request.sessionID] }
        const snapshot = await input.api.reply(request)
        commitSnapshot(snapshot, fence)
        return snapshot
      },
      settings: async (request: Parameters<typeof input.api.settings>[0]) => {
        const fence = { observed: data.descriptors[request.sessionID] }
        const descriptor = await input.api.settings(request)
        commitDescriptor(descriptor, fence)
        return descriptor
      },
    },
  }
}

function isStatus(error: unknown, status: number) {
  if (!error || typeof error !== "object") return false
  if ("status" in error && error.status === status) return true
  if (!("cause" in error) || !error.cause || typeof error.cause !== "object") return false
  return "status" in error.cause && error.cause.status === status
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}
