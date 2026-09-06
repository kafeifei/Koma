import { describe, expect, test } from "bun:test"
import { desiredCodexSettings, updateCodexSettings } from "./codex-prompt-controls"

describe("Codex prompt settings", () => {
  test("preserves applied and pending fields across consecutive setting changes", () => {
    const applied = { model: "gpt-5", effort: "medium", permission: "readOnly" as const }
    const model = updateCodexSettings(desiredCodexSettings({ settings: applied }, {}), { model: "gpt-6" })
    const effort = updateCodexSettings(desiredCodexSettings({ settings: applied, pendingSettings: model }, {}), {
      effort: "high",
    })
    const permission = updateCodexSettings(desiredCodexSettings({ settings: applied, pendingSettings: effort }, {}), {
      permission: "workspace",
    })

    expect(permission).toEqual({ model: "gpt-6", effort: "high", permission: "workspace" })
  })

  test("uses a saved unavailable model instead of displaying the advertised default", () => {
    expect(
      desiredCodexSettings(
        { settings: { model: "retired-model" }, pendingSettings: { effort: "high" } },
        { model: "draft-model" },
      ),
    ).toEqual({ model: "retired-model", effort: "high" })
  })
})
