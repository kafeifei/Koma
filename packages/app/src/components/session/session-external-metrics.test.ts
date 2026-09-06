import { expect, test } from "bun:test"
import { getExternalSessionMetrics } from "./session-external-metrics"

test("uses current native context separately from cumulative token accounting", () => {
  const metrics = getExternalSessionMetrics({
    usage: {
      status: "available",
      value: { total: 90, input: 50, output: 40, reasoning: 30, cache: { read: 20, write: 10 } },
    },
    contextTokens: { status: "available", value: 9 },
    contextWindow: { status: "available", value: 100 },
    cost: { status: "unavailable" },
  })
  expect(metrics.usage).toBe(9)
  expect(metrics.current).toBe(9)
  expect(metrics.tokens?.total).toBe(90)
  expect(metrics.cost).toBeUndefined()
})

test("missing or loading native metrics never become zero usage or free cost", () => {
  expect(getExternalSessionMetrics().usage).toBeUndefined()
  const metrics = getExternalSessionMetrics({
    usage: { status: "unavailable" },
    contextTokens: { status: "loading" },
    contextWindow: { status: "available", value: 100 },
    cost: { status: "unavailable" },
  })
  expect(metrics.current).toBeUndefined()
  expect(metrics.usage).toBeUndefined()
  expect(metrics.tokens).toBeUndefined()
  expect(metrics.cost).toBeUndefined()
})
