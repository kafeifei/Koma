import { describe, expect, test } from "bun:test"
import type { ContextItem, Prompt, usePrompt } from "@/context/prompt"
import { createPromptSubmissionState } from "./submission-state"

type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>

describe("prompt submission state", () => {
  test("clears the captured context when it is still the submitted item", () => {
    const target = promptTarget()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })

    submission.clearContext()

    expect(target.context.items()).toEqual([])
  })

  test("does not clear a context item removed and re-added while acknowledgement is pending", () => {
    const target = promptTarget()
    const captured = target.context.items().slice()
    const submission = createPromptSubmissionState({ target, prompt: target.current(), context: captured })

    target.context.remove(captured[0]!.key)
    target.context.add({ type: "file", path: "src/a.ts" })
    submission.clearContext()

    expect(target.context.items()).toHaveLength(1)
    expect(target.context.items()[0]?.path).toBe("src/a.ts")
  })

  test("does not clear a re-added source context after a new-session submission is retargeted", () => {
    const source = promptTarget()
    const destination = promptTarget(false)
    const captured = source.context.items().slice()
    const submission = createPromptSubmissionState({ target: source, prompt: source.current(), context: captured })
    submission.retarget(destination)

    source.context.remove(captured[0]!.key)
    source.context.add({ type: "file", path: "src/a.ts" })
    submission.clearContext()
    submission.clear()

    expect(source.context.items()).toHaveLength(1)
    expect(destination.context.items()).toEqual([])
  })
})

function promptTarget(withContext = true) {
  const prompt: Prompt = [{ type: "text", content: "send", start: 0, end: 4 }]
  const state = {
    items: withContext ? [{ type: "file" as const, path: "src/a.ts", key: "file:src/a.ts" }] : [],
  }
  const target = {
    current: () => prompt,
    reset: () => undefined,
    set: () => undefined,
    context: {
      items: () => state.items,
      add: (item: ContextItem) => {
        if (state.items.some((current) => current.path === item.path)) return
        state.items = [...state.items, { ...item, key: `file:${item.path}` }]
      },
      remove: (key: string) => {
        state.items = state.items.filter((item) => item.key !== key)
      },
    },
  }
  return target as unknown as PromptTarget
}
