import { CodexWorktreeAccess } from "@opencode-ai/codex/worktree-access"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Effect, Layer } from "effect"
import { WorktreeLifecycle } from "./lifecycle"

export const node = makeGlobalNode({
  service: CodexWorktreeAccess.Service,
  layer: Layer.effect(
    CodexWorktreeAccess.Service,
    Effect.gen(function* () {
      const lifecycle = yield* WorktreeLifecycle.Service
      return CodexWorktreeAccess.Service.of({
        claim: (input) => lifecycle.claim(input),
        acquire: (input) => lifecycle.acquire(input),
        release: (input) => lifecycle.release(input),
      })
    }),
  ),
  deps: [WorktreeLifecycle.node],
})

export * as CodexAccess from "./codex-access"
