import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Effect, Exit, Option, Schema, Scope, Semaphore } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
// Serialize admission only; child execution and foreground waits remain concurrent.
const dispatch = Semaphore.makeUnsafe(1)
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  model: Schema.optional(Schema.String.check(Schema.isPattern(/^[^/\s]+\/\S+$/))).annotate({
    description:
      "Model for this dispatch, using an exact provider/model ID from the available models. Overrides the agent's configured model. Omit to keep a resumed task's model, or use the agent/parent default for a new task.",
  }),
  variant: Schema.optional(Schema.String).annotate({
    description:
      "Reasoning preset supported by the selected model, such as low, medium, or high. Use default for the model's default. When selecting a different model, do not assume it supports the parent's preset.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const admitted = yield* dispatch.withPermit(
        Effect.gen(function* () {
          if (ctx.abort.aborted) return yield* Effect.interrupt
          const next = yield* agent.get(params.subagent_type)
          if (!next) {
            return yield* Effect.fail(
              new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`),
            )
          }

          const session = params.task_id
            ? yield* sessions
                .get(SessionID.make(params.task_id))
                .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            : undefined
          const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.orDie,
          )
          if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
          const parentVariant = msg.info.variant

          const job = session ? yield* background.get(session.id) : undefined
          const running = job?.status === "running" ? taskModel(job.metadata) : undefined
          const history =
            session && !session.model && !running
              ? yield* sessions.findMessage(session.id, (message) => message.info.role === "user")
              : Option.none()
          const previous =
            running ??
            (session?.model
              ? {
                  modelID: session.model.id,
                  providerID: session.model.providerID,
                  variant: session.model.variant ?? "default",
                }
              : Option.isSome(history) && history.value.info.role === "user"
                ? { ...history.value.info.model, variant: history.value.info.model.variant ?? "default" }
                : undefined)
          const model = params.model
            ? Provider.parseModel(params.model)
            : (previous ?? next.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID })
          const configured = next.model?.modelID === model.modelID && next.model?.providerID === model.providerID
          const full =
            params.model !== undefined || params.variant !== undefined || (configured && next.variant && !previous)
              ? yield* provider.getModel(model.providerID, model.modelID)
              : undefined
          const agentVariant = configured && next.variant && full?.variants?.[next.variant] ? next.variant : undefined
          const variant =
            params.variant ??
            (params.model
              ? (agentVariant ?? "default")
              : previous
                ? previous.variant
                : next.model
                  ? agentVariant
                  : parentVariant)
          if (params.variant !== undefined && params.variant !== "default" && !full?.variants?.[params.variant]) {
            return yield* Effect.fail(
              new Error(
                `Unknown variant "${params.variant}" for ${model.providerID}/${model.modelID}. Available variants: ${["default", ...Object.keys(full?.variants ?? {})].join(", ")}`,
              ),
            )
          }
          // A follow-up may extend a running job, but cannot relabel or switch its active provider request.
          if (
            running &&
            (running.modelID !== model.modelID ||
              running.providerID !== model.providerID ||
              (running.variant ?? "default") !== (variant ?? "default"))
          ) {
            return yield* Effect.fail(
              new Error("Cannot change the model or variant of a running task. Wait for it to finish."),
            )
          }
          const childPermission = deriveSubagentSessionPermission({
            parentSessionPermission: parent.permission ?? [],
            subagent: next,
          })
          const childToolDenies = [
            ...(next.permission.some((rule) => rule.permission === "todowrite")
              ? []
              : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
            ...(next.permission.some((rule) => rule.permission === id)
              ? []
              : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
            ...(cfg.experimental?.primary_tools?.map((permission) => ({
              permission,
              pattern: "*" as const,
              action: "deny" as const,
            })) ?? []),
          ]
          if (ctx.abort.aborted) return yield* Effect.interrupt
          const nextSession =
            session ??
            (yield* sessions.create({
              parentID: ctx.sessionID,
              title: params.description + ` (@${next.name} subagent)`,
              agent: next.name,
              model: { id: model.modelID, providerID: model.providerID, variant: variant ?? "default" },
              permission: [
                ...childPermission,
                ...childToolDenies.filter(
                  (deny) =>
                    !childPermission.some(
                      (rule) =>
                        rule.permission === deny.permission &&
                        rule.pattern === deny.pattern &&
                        rule.action === deny.action,
                    ),
                ),
              ],
            }))

          const metadata = {
            parentSessionId: ctx.sessionID,
            sessionId: nextSession.id,
            model: { modelID: model.modelID, providerID: model.providerID },
            ...(variant ? { variant } : {}),
            ...(runInBackground ? { background: true } : {}),
          }

          yield* ctx.metadata({
            title: params.description,
            metadata,
          })

          const ops = ctx.extra?.promptOps as TaskPromptOps
          if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

          const runTask = Effect.fn("TaskTool.runTask")(function* () {
            const parts = yield* ops.resolvePromptParts(params.prompt)
            const result = yield* ops.prompt({
              messageID: MessageID.ascending(),
              sessionID: nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              variant,
              agent: next.name,
              parts,
            })
            if (result.info.role === "assistant" && result.info.error) {
              const message =
                "message" in result.info.error.data && typeof result.info.error.data.message === "string"
                  ? result.info.error.data.message
                  : result.info.error.name
              return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
            }
            const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
            if (failed?.type === "tool" && failed.state.status === "error") {
              return yield* Effect.fail(
                new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`),
              )
            }
            return result.parts.findLast((item) => item.type === "text")?.text ?? ""
          })

          const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
            state: "completed" | "error",
            text: string,
          ) {
            const currentParent = yield* sessions.get(ctx.sessionID)
            yield* ops
              .prompt({
                sessionID: ctx.sessionID,
                agent: currentParent.agent ?? ctx.agent,
                variant: parentVariant,
                parts: [
                  {
                    type: "text",
                    synthetic: true,
                    text: renderOutput({
                      sessionID: nextSession.id,
                      state,
                      summary:
                        state === "completed"
                          ? `Background task completed: ${params.description}`
                          : `Background task failed: ${params.description}`,
                      text,
                    }),
                  },
                ],
              })
              .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
          })

          const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
            yield* background.wait({ id: jobID }).pipe(
              Effect.flatMap((result) => {
                if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
                if (result.info?.status === "error") return inject("error", result.info.error ?? "")
                return Effect.void
              }),
              Effect.forkIn(scope, { startImmediately: true }),
            )
          })

          if (ctx.abort.aborted) return yield* Effect.interrupt
          if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
            return Effect.succeed({
              title: params.description,
              metadata: {
                ...metadata,
                background: true,
                jobId: nextSession.id,
              },
              output: renderOutput({
                sessionID: nextSession.id,
                state: "running",
                summary: "Background task updated",
                text: BACKGROUND_UPDATED,
              }),
            })
          }

          const info = yield* background.start({
            id: nextSession.id,
            type: id,
            title: params.description,
            metadata,
            onPromote: Effect.all([
              ctx.metadata({
                title: params.description,
                metadata: { ...metadata, background: true, jobId: nextSession.id },
              }),
              notify(nextSession.id),
            ]),
            run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
          })

          function backgroundResult() {
            return {
              title: params.description,
              metadata: {
                ...metadata,
                background: true,
                jobId: info.id,
              },
              output: renderOutput({
                sessionID: nextSession.id,
                state: "running",
                summary: "Background task started",
                text: BACKGROUND_STARTED,
              }),
            }
          }

          if (runInBackground) {
            yield* notify(info.id)
            return Effect.succeed(backgroundResult())
          }

          const runCancel = yield* EffectBridge.make()
          const cancel = ops.cancel(nextSession.id)

          function onAbort() {
            runCancel.fork(cancel)
          }

          return Effect.acquireUseRelease(
            Effect.sync(() => {
              ctx.abort.addEventListener("abort", onAbort)
              if (ctx.abort.aborted) onAbort()
            }),
            () =>
              Effect.gen(function* () {
                const result = yield* Effect.raceFirst(
                  background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
                  background.waitForPromotion(nextSession.id),
                )
                if (result?.metadata?.background === true) return backgroundResult()
                if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
                if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
                return {
                  title: params.description,
                  metadata,
                  output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
                }
              }),
            (_, exit) =>
              Effect.gen(function* () {
                if (Exit.hasInterrupts(exit))
                  yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.abort.removeEventListener("abort", onAbort)
                  }),
                ),
              ),
          )
        }),
      )
      return yield* admitted
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function taskModel(metadata: BackgroundJob.Info["metadata"]) {
  const model = metadata?.model
  if (
    !model ||
    typeof model !== "object" ||
    !("providerID" in model) ||
    !("modelID" in model) ||
    typeof model.providerID !== "string" ||
    typeof model.modelID !== "string"
  )
    return
  return {
    ...Provider.parseModel(`${model.providerID}/${model.modelID}`),
    variant: typeof metadata.variant === "string" ? metadata.variant : "default",
  }
}
