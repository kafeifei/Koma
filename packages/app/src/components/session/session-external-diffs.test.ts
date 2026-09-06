import { expect, test } from "bun:test"
import { getExternalTurnDiff } from "./session-external-diffs"

test("selects the exact native turn instead of the last diff or message ID order", () => {
  const selected = {
    status: "available" as const,
    value: [{ file: "native.txt", patch: "patch", additions: 1, deletions: 0 }],
  }
  const snapshot = {
    messages: [
      {
        id: "user-b",
        type: "user" as const,
        text: "hello",
        time: {},
        orderKey: "z",
        metadata: { codex: { turnID: "turn-a" } },
      },
    ],
    turnDiffs: { "turn-a": selected, "turn-b": { status: "unavailable" as const } },
  }
  expect(getExternalTurnDiff(snapshot, "user-b")).toBe(selected)
  expect(getExternalTurnDiff(snapshot, "missing")).toBeUndefined()
  expect(getExternalTurnDiff(undefined, "user-b")).toBeUndefined()
})

test("preserves unavailable and confirmed empty native diffs as different facts", () => {
  const snapshot = {
    messages: [
      {
        id: "user-a",
        type: "user" as const,
        text: "hello",
        time: {},
        orderKey: "a",
        metadata: { codex: { turnID: "turn-a" } },
      },
    ],
    turnDiffs: { "turn-a": { status: "unavailable" as const } },
  }
  expect(getExternalTurnDiff(snapshot, "user-a")).toEqual({ status: "unavailable" })
  expect(
    getExternalTurnDiff({ ...snapshot, turnDiffs: { "turn-a": { status: "available", value: [] } } }, "user-a"),
  ).toEqual({ status: "available", value: [] })
})
