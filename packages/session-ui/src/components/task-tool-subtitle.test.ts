import { describe, expect, test } from "bun:test"
import { taskToolSubtitle } from "./task-tool-subtitle"

describe("taskToolSubtitle", () => {
  test("keeps the existing subtitle when model metadata is absent", () => {
    expect(taskToolSubtitle({ description: "Review the diff" }, { sessionId: "session_1" })).toBe("Review the diff")
  })

  test("shows the backend model and variant after the existing subtitle", () => {
    expect(
      taskToolSubtitle(
        { description: "Review the diff" },
        { model: { providerID: "openai", modelID: "gpt-5.6-luna" }, variant: "high" },
      ),
    ).toBe("Review the diff \u00B7 openai/gpt-5.6-luna \u00B7 high")
  })

  test("ignores incomplete model metadata and preserves the fallback", () => {
    expect(taskToolSubtitle({}, { model: { providerID: "openai" } }, "session_1")).toBe("session_1")
  })
})
