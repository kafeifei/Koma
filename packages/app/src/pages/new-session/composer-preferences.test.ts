import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import {
  normalizeOpenCodePreference,
  sanitizeComposerPreferences,
  type SavedComposerPreferences,
  updateComposerPreference,
} from "./composer-preferences"

describe("composer preferences", () => {
  test("creates the project and engine sections on the first selection", () => {
    const [saved, setSaved] = createStore<SavedComposerPreferences>({ target: {} })

    updateComposerPreference(saved, setSaved, "server-project", {
      opencode: { model: { providerID: "openai", modelID: "gpt-5.6", variant: "high" } },
    })
    updateComposerPreference(saved, setSaved, "server-project", { opencode: { permission: "auto" } })
    updateComposerPreference(saved, setSaved, "server-project", {
      codex: { model: "gpt-6", effort: "high", permission: "workspace" },
    })

    expect(saved.target["server-project"]).toEqual({
      opencode: {
        model: { providerID: "openai", modelID: "gpt-5.6", variant: "high" },
        permission: "auto",
      },
      codex: { model: "gpt-6", effort: "high", permission: "workspace" },
    })
  })

  test("keeps only supported persisted fields", () => {
    expect(
      sanitizeComposerPreferences({
        engine: "codex",
        opencode: {
          model: { providerID: "openai", modelID: "gpt-5.6", variant: "high", secret: true },
          permission: "full",
        },
        codex: { model: "gpt-6", effort: "high", permission: "readOnly", queue: "paused" },
      }),
    ).toEqual({
      engine: "codex",
      opencode: { model: { providerID: "openai", modelID: "gpt-5.6", variant: "high" }, permission: "full" },
      codex: { model: "gpt-6", effort: "high", permission: "readOnly" },
    })
  })

  test("drops a variant that is not valid for the selected model", () => {
    expect(normalizeOpenCodePreference({ providerID: "openai", modelID: "gpt-6", variant: "max" }, ["high"])).toEqual({
      providerID: "openai",
      modelID: "gpt-6",
    })
  })
})
