import { CodexHost } from "@opencode-ai/codex/host"
import { LabError } from "@opencode-ai/protocol/groups/lab"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { StorageDirectory } from "@opencode-ai/core/storage-directory"
import { AbsolutePath } from "@opencode-ai/core/schema"

export const LabHandler = HttpApiBuilder.group(Api, "server.lab", (handlers) =>
  Effect.gen(function* () {
    const host = yield* CodexHost.Service
    const request = <A>(value: Effect.Effect<A, CodexHost.HostError>) =>
      value.pipe(Effect.mapError((error) => new LabError({ code: error.code, message: error.message })))
    return handlers
      .handle("lab.engines", () => request(host.engines()))
      .handle("lab.account", () => request(host.account()))
      .handle("lab.login", () => request(host.login()))
      .handle("lab.cancelLogin", (ctx) => request(host.cancelLogin(ctx.payload.loginID)))
      .handle("lab.describe", (ctx) => request(host.describe(ctx.payload.sessionIDs)))
      .handle("lab.create", (ctx) =>
        request(
          host.create({
            ...ctx.payload,
            location: {
              ...ctx.payload.location,
              directory: AbsolutePath.make(StorageDirectory.resolve(ctx.payload.location.directory)),
            },
          }),
        ),
      )
      .handle("lab.snapshot", (ctx) => request(host.snapshot(ctx.params.sessionID)))
      .handle("lab.submit", (ctx) => request(host.submit(ctx.params.sessionID, ctx.payload)))
      .handle("lab.delivery", (ctx) => request(host.delivery(ctx.params.sessionID, ctx.params.requestID)))
      .handle("lab.queue", (ctx) => request(host.queue(ctx.params.sessionID, ctx.payload)))
      .handle("lab.interrupt", (ctx) => request(host.interrupt(ctx.params.sessionID)))
      .handle("lab.reply", (ctx) => request(host.reply(ctx.params.sessionID, ctx.params.interactionID, ctx.payload)))
      .handle("lab.settings", (ctx) => request(host.settings(ctx.params.sessionID, ctx.payload)))
  }),
)
