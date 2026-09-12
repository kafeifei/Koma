import { describe, expect, test } from "bun:test"
import type { LabSnapshotOutput } from "@opencode-ai/lab-client"
import {
  actionableCodexDeliveries,
  codexFormContent,
  codexFormFields,
  codexSessionInteractionBlocked,
  isCodexDeliveryActive,
  isConfirmedCodexDelivery,
  needsCodexDeliveryConfirmation,
} from "./codex-session-controls"

const snapshot = (runtimeStatus: LabSnapshotOutput["descriptor"]["runtimeStatus"], pending = true) =>
  ({
    descriptor: { runtimeStatus },
    interactions: pending ? [{ state: "pending" }] : [],
  }) as unknown as LabSnapshotOutput

describe("Codex conditional docks", () => {
  test("blocks the composer only while the backend is waiting on a pending native interaction", () => {
    expect(codexSessionInteractionBlocked(snapshot("waitingApproval"))).toBe(true)
    expect(codexSessionInteractionBlocked(snapshot("waitingInput"))).toBe(true)
    expect(codexSessionInteractionBlocked(snapshot("active"))).toBe(false)
    expect(codexSessionInteractionBlocked(snapshot("waitingApproval", false))).toBe(false)
    expect(codexSessionInteractionBlocked(undefined)).toBe(false)
  })

  test("hides settled delivery receipts from the queue dock", () => {
    const deliveries = [
      { requestID: "pending", state: "pending" },
      { requestID: "paused", state: "paused" },
      { requestID: "returned", state: "returned" },
      { requestID: "accepted", state: "accepted", nativeItemID: "item-1" },
      { requestID: "unconfirmed", state: "accepted" },
      { requestID: "withdrawn", state: "withdrawn" },
      { requestID: "unknown", state: "unknown" },
    ] as unknown as LabSnapshotOutput["deliveries"]

    expect(actionableCodexDeliveries(deliveries).map((delivery) => delivery.requestID)).toEqual([
      "pending",
      "paused",
      "returned",
      "unconfirmed",
      "unknown",
    ])
  })

  test("requires native item evidence before treating an accepted receipt as settled", () => {
    expect(isConfirmedCodexDelivery({ state: "accepted", nativeItemID: "item-1" })).toBe(true)
    expect(isConfirmedCodexDelivery({ state: "accepted" })).toBe(false)
    expect(needsCodexDeliveryConfirmation({ state: "accepted" })).toBe(true)
    expect(needsCodexDeliveryConfirmation({ state: "accepted", nativeItemID: "item-1" })).toBe(false)
    expect(isCodexDeliveryActive("active")).toBe(true)
    expect(isCodexDeliveryActive("waitingInput")).toBe(true)
    expect(isCodexDeliveryActive("interrupting")).toBe(true)
    expect(isCodexDeliveryActive("idle")).toBe(false)
  })
})

describe("Codex MCP form controls", () => {
  test("preserves opaque option values and produces typed content", () => {
    const fields = codexFormFields({
      type: "object",
      required: ["mode", "count"],
      properties: {
        mode: {
          type: "string",
          title: "Mode",
          oneOf: [
            { const: "opaque-safe", title: "Safe" },
            { const: "opaque-fast", title: "Fast" },
          ],
        },
        count: { type: "integer", title: "Count", minimum: 1, maximum: 4 },
        enabled: { type: "boolean", title: "Enabled", default: true },
        scopes: {
          type: "array",
          title: "Scopes",
          items: { anyOf: [{ const: "opaque-read", title: "Read" }] },
          minItems: 1,
        },
      },
    })

    expect(fields).toBeDefined()
    expect(fields?.[0]?.options).toEqual([
      { label: "Safe", value: "opaque-safe" },
      { label: "Fast", value: "opaque-fast" },
    ])
    expect(
      codexFormContent(fields!, {
        mode: "opaque-fast",
        count: "3",
        scopes: ["opaque-read"],
      }),
    ).toEqual({ mode: "opaque-fast", count: 3, enabled: true, scopes: ["opaque-read"] })
  })

  test("rejects incomplete or out-of-range content before replying", () => {
    const fields = codexFormFields({
      type: "object",
      required: ["name", "count"],
      properties: {
        name: { type: "string", minLength: 2 },
        count: { type: "integer", minimum: 1 },
      },
    })!

    expect(codexFormContent(fields, { name: "x", count: "2" })).toBeUndefined()
    expect(codexFormContent(fields, { name: "ok", count: "0" })).toBeUndefined()
    expect(codexFormContent(fields, { name: "ok", count: "1.5" })).toBeUndefined()
  })

  test("does not render unsupported property schemas as a partial form", () => {
    expect(
      codexFormFields({
        type: "object",
        properties: {
          supported: { type: "string" },
          nested: { type: "object", properties: {} },
        },
      }),
    ).toBeUndefined()
  })
})
