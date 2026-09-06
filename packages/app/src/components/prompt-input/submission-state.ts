import { type ContextItem, type Prompt, type usePrompt } from "@/context/prompt"

type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>

export function createPromptSubmissionState(input: {
  target: PromptTarget
  prompt: Prompt
  context: (ContextItem & { key: string })[]
}) {
  const initial = input.target
  let target = input.target
  let expected = input.target.current()
  let cleared: Prompt | undefined
  const contexts = new WeakMap<PromptTarget, Map<string, ContextItem & { key: string }>>()
  contexts.set(initial, new Map(input.context.map((item) => [item.key, item])))

  const clearCapturedContext = (value: PromptTarget) => {
    const captured = contexts.get(value)
    if (!captured) return
    for (const item of value.context.items()) {
      if (captured.get(item.key) === item) value.context.remove(item.key)
    }
  }

  return {
    prompt: input.prompt,
    context: input.context,
    target: () => target,
    clear() {
      // Creating a session can finish after the user edits or leaves its source input.
      if (initial !== target && initial.current() === input.prompt) {
        initial.reset()
        clearCapturedContext(initial)
      }
      if (target.current() !== expected) return false
      target.reset()
      cleared = target.current()
      return true
    },
    clearContext() {
      clearCapturedContext(initial)
      if (initial !== target) clearCapturedContext(target)
    },
    retarget(next: PromptTarget) {
      const existing = new Set(next.context.items().map((item) => item.key))
      input.context.forEach(next.context.add)
      contexts.set(
        next,
        new Map(next.context.items().flatMap((item) => (!existing.has(item.key) ? [[item.key, item]] : []))),
      )
      target = next
      expected = next.current()
    },
    current: (value: PromptTarget) => target === value,
    restore() {
      if (target.current() !== (cleared ?? expected)) return
      return { target, prompt: input.prompt, context: input.context }
    },
    preserve() {
      target.set(input.prompt)
      expected = target.current()
    },
  }
}
