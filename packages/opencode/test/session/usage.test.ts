import { describe, expect, test } from "bun:test"
import { Usage } from "@opencode-ai/llm"
import { Session } from "@/session/session"

const model = (context: number) =>
  ({
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context, output: 8_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai" },
    options: {},
  }) as never

describe("Session.getUsage context", () => {
  test("does not invent zero context usage when a Provider omitted its token counts", () => {
    expect(Session.getUsage({ model: model(1000), usage: new Usage({}) }).context).toBeUndefined()
  })

  test("preserves explicitly reported zero usage", () => {
    expect(
      Session.getUsage({
        model: model(1000),
        usage: new Usage({ inputTokens: 0, outputTokens: 0 }),
      }).context,
    ).toEqual({ limit: 1000, used: 0, ratio: 0 })
  })

  test("reports raw input plus raw output against the model context limit", () => {
    const result = Session.getUsage({
      model: model(1000),
      usage: new Usage({
        inputTokens: 600,
        outputTokens: 200,
        reasoningTokens: 50,
        cacheReadInputTokens: 100,
        cacheWriteInputTokens: 50,
        totalTokens: 9999,
      }),
    })

    expect(result.context).toEqual({ limit: 1000, used: 800, ratio: 0.8 })
    // The client-side total the app used to compute must stay identical to `used`.
    expect(
      result.tokens.input +
        result.tokens.output +
        result.tokens.reasoning +
        result.tokens.cache.read +
        result.tokens.cache.write,
    ).toBe(result.context!.used)
  })

  test("keeps an unrounded ratio", () => {
    expect(
      Session.getUsage({
        model: model(3),
        usage: new Usage({ inputTokens: 1, outputTokens: 0 }),
      }).context?.ratio,
    ).toBe(1 / 3)
  })

  test("omits context when the model has no known limit", () => {
    expect(
      Session.getUsage({
        model: model(0),
        usage: new Usage({ inputTokens: 600, outputTokens: 200 }),
      }).context,
    ).toBeUndefined()
  })
})
