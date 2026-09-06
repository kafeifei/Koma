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

  return {
    prompt: input.prompt,
    context: input.context,
    target: () => target,
    clear() {
      // Creating a session can finish after the user edits or leaves its source input.
      if (initial !== target && initial.current() === input.prompt) {
        initial.reset()
        for (const item of input.context) initial.context.remove(item.key)
      }
      if (target.current() !== expected) return
      target.reset()
      cleared = target.current()
    },
    retarget(next: PromptTarget) {
      input.context.forEach(next.context.add)
      target = next
      expected = next.current()
    },
    current: (value: PromptTarget) => target === value,
    restore() {
      if (target.current() !== (cleared ?? expected)) return
      return { target, prompt: input.prompt, context: input.context }
    },
  }
}
