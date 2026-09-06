import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState, DEFAULT_PROMPT } from "./prompt-state"

describe("prompt state initialization", () => {
  test("initializes prompt text, cursor, and model together", () => {
    createRoot((dispose) => {
      const model = { providerID: "anthropic", modelID: "claude", variant: "high" }
      const prompt = createPromptState({ prompt: "hello", model })

      expect(prompt.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
      expect(prompt.cursor()).toBe(5)
      expect(prompt.model.current()).toEqual(model)
      expect(prompt.model.current()).not.toBe(model)
      dispose()
    })
  })

  test("uses the default prompt without initial values", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()

      expect(prompt.current()).toEqual(DEFAULT_PROMPT)
      expect(prompt.cursor()).toBeUndefined()
      expect(prompt.model.current()).toBeUndefined()
      expect(prompt.engine.current()).toBe("opencode")
      expect(prompt.codex.current()).toEqual({})
      expect(prompt.externalRequest.current()).toBeUndefined()
      dispose()
    })
  })

  test("keeps engine settings and external retry identity when the submitted text is reset", () => {
    createRoot((dispose) => {
      const prompt = createPromptState({
        prompt: "hello",
        engine: "codex",
        codex: { model: "gpt-6", effort: "high", permission: "workspace" },
      })
      const request = { requestID: "request-1", fingerprint: "same-input", operation: "create" as const }

      prompt.externalRequest.set(request)
      prompt.codex.set({ model: "gpt-6", effort: "high", permission: "full" })
      prompt.reset()

      expect(prompt.current()).toEqual(DEFAULT_PROMPT)
      expect(prompt.engine.current()).toBe("codex")
      expect(prompt.codex.current()).toEqual({ model: "gpt-6", effort: "high", permission: "full" })
      expect(prompt.codex.revision()).toBe(1)
      expect(prompt.externalRequest.current()).toEqual(request)
      dispose()
    })
  })
})
