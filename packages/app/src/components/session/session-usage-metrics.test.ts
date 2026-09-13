import { expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import type { LabSnapshotOutput } from "@opencode-ai/lab-client"
import { getSessionUsageMetrics } from "./session-usage-metrics"

const input = { external: false, messages: [] as Message[], providers: [] }
const message = {
  role: "assistant",
  providerID: "openai",
  modelID: "model",
  tokens: { input: 20, output: 30, reasoning: 10, cache: { read: 40, write: 0 } },
  context: { used: 80, limit: 200, ratio: 0.4 },
} as Message

test("does not manufacture zero usage or zero cost from absent data", () => {
  expect(getSessionUsageMetrics({ ...input, cost: 0 })).toEqual({
    providerID: undefined,
    current: undefined,
    limit: undefined,
    percent: undefined,
    cost: undefined,
  })
})

test("uses the Provider's current context value rather than summed billing tokens", () => {
  expect(getSessionUsageMetrics({ ...input, messages: [message], cost: 0.25 })).toEqual({
    providerID: "openai",
    current: 80,
    limit: 200,
    percent: 40,
    cost: 0.25,
  })
})

test("keeps a reported zero context usage", () => {
  const zero = {
    ...message,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    context: { used: 0, limit: 200, ratio: 0 },
  } as Message
  expect(getSessionUsageMetrics({ ...input, messages: [zero] }).percent).toBe(0)
})

test("omits percentage when the Provider has no usable context limit", () => {
  const unknown = { ...message, context: undefined } as Message
  for (const limit of [0, NaN, Infinity, -1]) {
    const providers = [{ id: "openai", models: { model: { limit: { context: limit } } } }]
    const metrics = getSessionUsageMetrics({ ...input, messages: [unknown], providers })
    expect(metrics.current).toBe(100)
    expect(metrics.percent).toBeUndefined()
    expect(metrics.limit).toBeUndefined()
  }
})

test("native usage uses current context, not cumulative tokens, and preserves explicit zero cost", () => {
  const snapshot = {
    usage: { status: "available", value: { total: 9000 } },
    contextTokens: { status: "available", value: 80 },
    contextWindow: { status: "available", value: 200 },
    cost: { status: "available", value: 0 },
  } as LabSnapshotOutput
  const metrics = getSessionUsageMetrics({ ...input, external: true, snapshot })
  expect(metrics.percent).toBe(40)
  expect(metrics.current).toBe(80)
  expect(metrics.cost).toBe(0)
})

test("native loading and unavailable values do not inherit synthetic projected tokens", () => {
  const snapshot = {
    usage: { status: "loading" },
    contextTokens: { status: "unavailable" },
    contextWindow: { status: "available", value: 200 },
    cost: { status: "unavailable" },
  } as LabSnapshotOutput
  const metrics = getSessionUsageMetrics({ ...input, external: true, snapshot, messages: [message], cost: 3 })
  expect(metrics.percent).toBeUndefined()
  expect(metrics.current).toBeUndefined()
  expect(metrics.cost).toBeUndefined()
})
