export * as WorktreeBranch from "./branch"

import { InstanceState } from "@/effect/instance-state"
import { Git } from "@opencode-ai/core/git"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { Worktree } from "."
import { WorktreeLifecycle } from "./lifecycle"

export const CheckoutInput = Schema.Struct({
  branch: Schema.String.check(
    Schema.makeFilter((value) => (value.trim() === value && value.length > 0 ? undefined : "Expected a local branch")),
  ),
}).annotate({ identifier: "WorktreeCheckoutInput" })
export type CheckoutInput = Schema.Schema.Type<typeof CheckoutInput>

export const CheckoutResult = Schema.Struct({
  branch: Schema.String,
}).annotate({ identifier: "WorktreeCheckoutResult" })
export type CheckoutResult = Schema.Schema.Type<typeof CheckoutResult>

export class CheckoutFailedError extends Schema.TaggedErrorClass<CheckoutFailedError>()("WorktreeCheckoutFailedError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly checkout: (input: CheckoutInput) => Effect.Effect<CheckoutResult, Worktree.NotGitError | CheckoutFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeBranch") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const lifecycle = yield* WorktreeLifecycle.Service

    const checkout = Effect.fn("WorktreeBranch.checkout")(function* (input: CheckoutInput) {
      if (
        input.branch.length === 0 ||
        input.branch.trim() !== input.branch ||
        input.branch.startsWith("-") ||
        input.branch === "HEAD" ||
        input.branch.startsWith("refs/")
      ) {
        return yield* new CheckoutFailedError({ message: `Invalid local branch: ${input.branch}` })
      }

      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new Worktree.NotGitError({ message: "Branch checkout is only supported for git projects" })
      }

      const repository = yield* git.repo.discover(AbsolutePath.make(ctx.worktree))
      if (!repository) {
        return yield* new Worktree.NotGitError({ message: "Git repository could not be opened" })
      }

      const current = yield* git.history.branch(repository)
      if (current === input.branch) return { branch: current }

      if (!(yield* git.history.hasLocalBranch(repository, input.branch))) {
        return yield* new CheckoutFailedError({ message: `Local branch not found: ${input.branch}` })
      }

      return yield* lifecycle
        .withIdleDirectory(
          repository.worktree,
          Effect.gen(function* () {
            const latest = yield* git.history.branch(repository)
            if (latest === input.branch) return { branch: latest }
            if (!(yield* git.history.hasLocalBranch(repository, input.branch))) {
              return yield* new CheckoutFailedError({ message: `Local branch not found: ${input.branch}` })
            }
            yield* git.sync
              .checkoutRemoteBranch(repository, { branch: input.branch, reset: false })
              .pipe(Effect.mapError((error) => new CheckoutFailedError({ message: error.message })))
            const branch = yield* git.history.branch(repository)
            if (branch === input.branch) return { branch }
            return yield* new CheckoutFailedError({ message: `Git did not switch to local branch: ${input.branch}` })
          }),
        )
        .pipe(Effect.mapError((error) => new CheckoutFailedError({ message: error.message })))
    })

    return Service.of({ checkout })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Git.node, WorktreeLifecycle.node],
})
