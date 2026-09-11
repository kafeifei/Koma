import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionEngineGuard } from "@opencode-ai/core/session/external/guard"
import { PartTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID } from "./schema"
import { Session } from "./session"

export type Input = {
  sessionID: SessionID
  childSessionID: SessionID
  sourceMessageID: MessageID
  callID?: string
  state: "completed" | "error"
  text: string
}

export type Receipt = {
  messageID: MessageID
  accepted: boolean
}

/** Internal result admission does not execute tools, acquire a directory, or change user settings. */
export const record = Effect.fn("SessionTaskResult.record")(function* (input: Input) {
  const database = yield* Database.Service
  const sessions = yield* Session.Service
  const key = createHash("sha256")
    .update(JSON.stringify([input.sessionID, input.childSessionID, input.sourceMessageID, input.callID ?? null]))
    .digest("hex")
  const partID = PartID.make(`prt_task_${key}`)

  return yield* database.db
    .transaction(
      () =>
        Effect.gen(function* () {
          yield* SessionEngineGuard.requireOpenCode(database.db, input.sessionID, "receive task result").pipe(
            Effect.orDie,
          )
          const parent = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          const child = yield* sessions.get(input.childSessionID).pipe(Effect.orDie)
          if (child.parentID !== input.sessionID)
            return yield* Effect.die(new Error("Task result belongs to another parent"))

          const existing = yield* database.db.select().from(PartTable).where(eq(PartTable.id, partID)).get()
          if (existing) {
            const messageID = MessageID.make(existing.message_id)
            const message = yield* MessageV2.get({ sessionID: input.sessionID, messageID })
            const part = message.parts.find((part) => part.id === partID)
            if (
              existing.session_id !== input.sessionID ||
              message.info.role !== "user" ||
              part?.type !== "text" ||
              part.text !== input.text ||
              part.metadata?.taskResult?.state !== input.state
            )
              return yield* Effect.die(new Error("Task result identity was reused with different content"))
            return { messageID, accepted: false } satisfies Receipt
          }

          const source = yield* MessageV2.get({ sessionID: input.sessionID, messageID: input.sourceMessageID })
          if (source.info.role !== "assistant")
            return yield* Effect.die(new Error("Task result requires its source assistant"))
          const model = parent.model
            ? {
                providerID: ProviderV2.ID.make(parent.model.providerID),
                modelID: ModelV2.ID.make(parent.model.id),
                ...(parent.model.variant && parent.model.variant !== "default"
                  ? { variant: parent.model.variant }
                  : {}),
              }
            : {
                providerID: source.info.providerID,
                modelID: source.info.modelID,
                variant: source.info.variant,
              }
          // The stable part identity deduplicates retries; keep message IDs in
          // their ordinary chronological order for same-millisecond messages.
          const messageID = MessageID.ascending()
          const info: SessionV1.User = {
            id: messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: parent.agent ?? source.info.agent,
            model,
          }
          yield* sessions.updateMessage(info)
          yield* sessions.updatePart({
            id: partID,
            messageID,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text: input.text,
            metadata: {
              taskResult: {
                childSessionID: input.childSessionID,
                sourceMessageID: input.sourceMessageID,
                ...(input.callID ? { callID: input.callID } : {}),
                state: input.state,
              },
            },
          })
          yield* sessions.touch(input.sessionID)
          return { messageID, accepted: true } satisfies Receipt
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export * as SessionTaskResult from "./task-result"
