import { describe, expect, test } from "bun:test"
import type { LabDescribeOutput, LabSnapshotOutput } from "@opencode-ai/lab-client"
import { createSessionExternalContext, type SessionExternalCacheTarget } from "./session-external"

const capabilities = {
  prompt: true,
  steer: true,
  queue: "native" as const,
  compact: true,
  images: true,
  permissions: true,
}

const descriptor = (revision: number, epoch = "runtime-a"): LabDescribeOutput[number] => ({
  sessionID: "ses_codex",
  engine: "codex",
  epoch,
  revision,
  runtimeStatus: "active",
  capabilities,
  queuePaused: false,
  settings: { model: "gpt-5" },
})

const snapshot = (revision: number, epoch = "runtime-a"): LabSnapshotOutput => ({
  descriptor: descriptor(revision, epoch),
  messages: [{ id: "msg_user", type: "user", text: "hello", orderKey: "001", time: { created: 1 } }],
  messageOrder: ["msg_user"],
  partOrder: { msg_user: ["msg_user:text"] },
  interactions: [],
  deliveries: [],
  usage: { status: "unavailable" },
  contextWindow: { status: "unavailable" },
  cost: { status: "unavailable" },
  turnDiffs: {},
  sessionDiff: { status: "unavailable" },
  children: [],
})

function setup(overrides: Partial<Record<string, (...args: never[]) => unknown>> = {}) {
  const calls = { snapshots: 0, projections: 0, appends: 0, descriptors: 0 }
  const target: SessionExternalCacheTarget = {
    descriptor() {
      calls.descriptors++
    },
    snapshot() {
      calls.snapshots++
    },
    projection() {
      calls.projections++
    },
    append() {
      calls.appends++
      return true
    },
  }
  const api = {
    describe: async () => [descriptor(1)],
    snapshot: async () => snapshot(4),
    engines: async () => [],
    account: async () => ({ authenticated: true, requiresAuth: false }),
    login: async () => ({ loginID: "login", url: "https://example.test" }),
    cancelLogin: async () => ({ authenticated: false, requiresAuth: true }),
    create: async () => ({ descriptor: descriptor(1), delivery: delivery() }),
    submit: async () => ({ descriptor: descriptor(1), delivery: delivery() }),
    delivery: async () => delivery(),
    queue: async () => snapshot(2),
    interrupt: async () => descriptor(2),
    reply: async () => snapshot(2),
    settings: async () => descriptor(2),
    ...overrides,
  }
  const controller = createSessionExternalContext({
    api: api as unknown as Parameters<typeof createSessionExternalContext>[0]["api"],
    target: () => target,
  })
  return { controller, calls }
}

function delivery() {
  return {
    sessionID: "ses_codex",
    requestID: "request",
    state: "accepted" as const,
    delivery: "steer" as const,
    input: { prompt: { text: "hello" }, settings: {} },
    createdAt: 1,
  }
}

describe("external session controller", () => {
  test("applies contiguous changes and refreshes revision gaps", async () => {
    const { controller, calls } = setup()
    controller.apply({
      type: "session.external.changed",
      data: {
        sessionID: "ses_codex",
        epoch: "runtime-a",
        revision: 1,
        descriptor: descriptor(1),
        messages: snapshot(1).messages,
      },
    })
    controller.apply({
      type: "session.external.changed",
      data: {
        sessionID: "ses_codex",
        epoch: "runtime-a",
        revision: 1,
        append: { messageID: "msg_user", partID: "msg_user:text", type: "text", delta: "ignored" },
      },
    })
    controller.apply({
      type: "session.external.changed",
      data: {
        sessionID: "ses_codex",
        epoch: "runtime-a",
        revision: 2,
        append: { messageID: "msg_user", partID: "msg_user:text", type: "text", delta: " world" },
      },
    })
    controller.apply({
      type: "session.external.changed",
      data: { sessionID: "ses_codex", epoch: "runtime-a", revision: 4 },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(calls.projections).toBe(1)
    expect(calls.appends).toBe(1)
    expect(calls.snapshots).toBe(1)
    expect(controller.data.descriptors.ses_codex?.revision).toBe(4)
  })

  test("does not let an old snapshot cross a newer SSE epoch", async () => {
    const first = Promise.withResolvers<LabSnapshotOutput>()
    let requests = 0
    const { controller } = setup({
      snapshot: async () => {
        requests++
        if (requests === 1) return first.promise
        return snapshot(2, "runtime-b")
      },
    })
    controller.apply({
      type: "session.external.changed",
      data: { sessionID: "ses_codex", epoch: "runtime-a", revision: 1, descriptor: descriptor(1) },
    })
    const loading = controller.load("ses_codex", { force: true })
    await Promise.resolve()

    controller.apply({
      type: "session.external.changed",
      data: {
        sessionID: "ses_codex",
        epoch: "runtime-b",
        revision: 1,
        descriptor: descriptor(1, "runtime-b"),
        refresh: true,
      },
    })
    first.resolve(snapshot(9))
    await loading
    for (let index = 0; index < 5; index++) await Promise.resolve()

    expect(requests).toBe(2)
    expect(controller.data.descriptors.ses_codex).toMatchObject({ epoch: "runtime-b", revision: 2 })
    expect(controller.data.snapshots.ses_codex?.descriptor).toMatchObject({ epoch: "runtime-b", revision: 2 })
  })

  test("does not let old describe or action responses regress a newer SSE epoch", async () => {
    const described = Promise.withResolvers<LabDescribeOutput>()
    const submitted = Promise.withResolvers<{
      descriptor: LabDescribeOutput[number]
      delivery: ReturnType<typeof delivery>
    }>()
    const { controller } = setup({
      describe: async () => described.promise,
      submit: async () => submitted.promise,
      snapshot: async () => snapshot(2, "runtime-b"),
    })
    controller.apply({
      type: "session.external.changed",
      data: { sessionID: "ses_codex", epoch: "runtime-a", revision: 1, descriptor: descriptor(1) },
    })
    const describeRequest = controller.describe(["ses_codex"])
    const submitRequest = controller.actions.submit({
      sessionID: "ses_codex",
      requestID: "request",
      input: { prompt: { text: "hello" }, settings: {} },
      delivery: "steer",
    })

    controller.apply({
      type: "session.external.changed",
      data: {
        sessionID: "ses_codex",
        epoch: "runtime-b",
        revision: 1,
        descriptor: descriptor(1, "runtime-b"),
        refresh: true,
      },
    })
    described.resolve([descriptor(9)])
    submitted.resolve({ descriptor: descriptor(9), delivery: delivery() })
    const [descriptors] = await Promise.all([describeRequest, submitRequest])
    for (let index = 0; index < 5; index++) await Promise.resolve()

    expect(descriptors[0]).toMatchObject({ epoch: "runtime-b" })
    const lateDescriptors = await controller.describe(["ses_codex"])
    await controller.actions.submit({
      sessionID: "ses_codex",
      requestID: "stale-request",
      input: { prompt: { text: "late" }, settings: {} },
      delivery: "steer",
    })

    expect(lateDescriptors[0]).toMatchObject({ epoch: "runtime-b", revision: 2 })
    expect(controller.data.descriptors.ses_codex).toMatchObject({ epoch: "runtime-b", revision: 2 })
    expect(controller.data.snapshots.ses_codex?.descriptor).toMatchObject({ epoch: "runtime-b", revision: 2 })
    expect(controller.data.snapshots.ses_codex?.deliveries).toEqual([])
  })

  test("refreshes durable receipts when a newer SSE revision overtakes the submit ACK", async () => {
    const submitted = Promise.withResolvers<{
      descriptor: LabDescribeOutput[number]
      delivery: ReturnType<typeof delivery>
    }>()
    let snapshots = 0
    const { controller } = setup({
      submit: async () => submitted.promise,
      snapshot: async () => {
        snapshots++
        return snapshots === 1 ? snapshot(1) : { ...snapshot(2), deliveries: [delivery()] }
      },
    })
    await controller.load("ses_codex", { force: true })
    const submitting = controller.actions.submit({
      sessionID: "ses_codex",
      requestID: "request",
      input: delivery().input,
      delivery: "steer",
    })
    controller.apply({
      type: "session.external.changed",
      data: { sessionID: "ses_codex", epoch: "runtime-a", revision: 2, descriptor: descriptor(2) },
    })
    expect(snapshots).toBe(1)
    submitted.resolve({ descriptor: descriptor(1), delivery: delivery() })
    expect((await submitting).delivery.state).toBe("accepted")
    for (let index = 0; index < 5; index++) await Promise.resolve()

    expect(snapshots).toBe(2)
    expect(controller.data.descriptors.ses_codex?.revision).toBe(2)
    expect(controller.data.snapshots.ses_codex?.deliveries).toEqual([delivery()])
    expect(controller.data.snapshots.ses_codex?.deliveries[0]?.nativeItemID).toBeUndefined()
  })

  test("refreshes unconfirmed receipts after interruption without submitting them again", async () => {
    let snapshots = 0
    let submissions = 0
    const stopped = {
      ...snapshot(3),
      descriptor: { ...descriptor(3), runtimeStatus: "idle" as const, queuePaused: true },
      deliveries: [delivery()],
    }
    const { controller } = setup({
      snapshot: async () => (++snapshots === 1 ? snapshot(1) : stopped),
      interrupt: async () => ({ ...descriptor(2), runtimeStatus: "interrupting", queuePaused: true }),
      submit: async () => {
        submissions++
        return { descriptor: descriptor(4), delivery: delivery() }
      },
    })
    await controller.load("ses_codex", { force: true })
    await controller.actions.interrupt("ses_codex")
    for (let index = 0; index < 5; index++) await Promise.resolve()

    expect(snapshots).toBe(2)
    expect(controller.data.snapshots.ses_codex?.deliveries).toEqual([delivery()])
    expect(controller.data.descriptors.ses_codex).toMatchObject({ runtimeStatus: "idle", queuePaused: true })
    expect(submissions).toBe(0)
  })

  test("falls back to ordinary sessions only after a legacy 404 probe", async () => {
    const { controller } = setup({
      describe: async () => {
        throw Object.assign(new Error("not found"), { cause: { status: 404 } })
      },
    })

    expect(controller.engine("legacy")).toBeUndefined()
    expect(await controller.describe(["legacy"])).toEqual([])
    expect(controller.data.support).toBe("unsupported")
    expect(controller.engine("legacy")).toBe("opencode")
    expect(await controller.load("legacy")).toBe(false)
  })

  test("returns native action receipts while updating controller state", async () => {
    const interactionSnapshot = {
      ...snapshot(2),
      descriptor: { ...descriptor(2), bindingState: "failed" as const, runtimeStatus: "bindingUnavailable" as const },
      interactions: [
        {
          id: "interaction",
          sessionID: "ses_codex",
          revision: 1,
          kind: "question" as const,
          title: "Credentials",
          choices: [],
          questions: [{ id: "token", header: "Token", question: "Enter token", secret: true }],
          state: "pending" as const,
        },
      ],
    }
    const { controller } = setup({
      snapshot: async () => interactionSnapshot,
      reply: async () => interactionSnapshot,
    })
    const receipt = await controller.actions.create({
      requestID: "request",
      engine: "codex",
      location: { directory: "/repo" },
      input: { prompt: { text: "hello" }, settings: {} },
      delivery: "steer",
    })

    expect(receipt.delivery.state).toBe("accepted")
    expect(controller.engine("ses_codex")).toBe("codex")
    await controller.actions.reply({
      sessionID: "ses_codex",
      interactionID: "interaction",
      revision: 1,
      answers: { token: ["secret"] },
    })
    expect(controller.data.snapshots.ses_codex?.descriptor.bindingState).toBe("failed")
    expect(controller.data.snapshots.ses_codex?.interactions[0]?.questions?.[0]?.secret).toBe(true)
  })
})
