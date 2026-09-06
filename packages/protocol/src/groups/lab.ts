import { SessionExternal } from "@opencode-ai/schema/session-external"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"

export class LabError extends Schema.TaggedErrorClass<LabError>()(
  "LabError",
  {
    message: Schema.String,
    code: Schema.Literals(["unavailable", "conflict", "notFound", "invalid", "nativeError"]),
  },
  { httpApiStatus: 409 },
) {}

const accepted = Schema.Struct({ descriptor: SessionExternal.Descriptor, delivery: SessionExternal.Delivery })
const session = { sessionID: SessionID }

export const makeLabGroup = <I extends HttpApiMiddleware.AnyId, S>(location: Context.Key<I, S>) =>
  HttpApiGroup.make("server.lab")
    .add(
      HttpApiEndpoint.get("lab.engines", "/lab/engines", {
        success: Schema.Array(SessionExternal.Engine),
        error: LabError,
      }),
    )
    .add(
      HttpApiEndpoint.get("lab.account", "/lab/engines/codex/account", {
        success: SessionExternal.Account,
        error: LabError,
      }),
    )
    .add(
      HttpApiEndpoint.post("lab.login", "/lab/engines/codex/login", {
        success: SessionExternal.Login,
        error: LabError,
      }),
    )
    .add(
      HttpApiEndpoint.post("lab.cancelLogin", "/lab/engines/codex/login/cancel", {
        payload: Schema.Struct({ loginID: Schema.String }),
        success: SessionExternal.Account,
        error: LabError,
      }),
    )
    .add(
      HttpApiEndpoint.post("lab.describe", "/lab/sessions/describe", {
        payload: Schema.Struct({ sessionIDs: Schema.Array(SessionID) }),
        success: Schema.Array(SessionExternal.Descriptor),
        error: LabError,
      }),
    )
    .add(
      HttpApiEndpoint.post("lab.create", "/lab/sessions", {
        payload: SessionExternal.Create,
        success: accepted,
        error: LabError,
      }),
    )
    .add(
      HttpApiEndpoint.get("lab.snapshot", "/lab/sessions/:sessionID", {
        params: session,
        success: SessionExternal.Snapshot,
        error: LabError,
      }).middleware(location),
    )
    .add(
      HttpApiEndpoint.post("lab.submit", "/lab/sessions/:sessionID/input", {
        params: session,
        payload: SessionExternal.Submit,
        success: accepted,
        error: LabError,
      }).middleware(location),
    )
    .add(
      HttpApiEndpoint.get("lab.delivery", "/lab/sessions/:sessionID/deliveries/:requestID", {
        params: { ...session, requestID: Schema.String },
        success: SessionExternal.Delivery,
        error: LabError,
      }).middleware(location),
    )
    .add(
      HttpApiEndpoint.post("lab.queue", "/lab/sessions/:sessionID/queue", {
        params: session,
        payload: Schema.Struct({
          action: Schema.Literals(["resume", "withdraw"]),
          requestID: Schema.String,
          revision: Schema.Int,
        }),
        success: SessionExternal.Snapshot,
        error: LabError,
      }).middleware(location),
    )
    .add(
      HttpApiEndpoint.post("lab.interrupt", "/lab/sessions/:sessionID/interrupt", {
        params: session,
        success: SessionExternal.Descriptor,
        error: LabError,
      }).middleware(location),
    )
    .add(
      HttpApiEndpoint.post("lab.reply", "/lab/sessions/:sessionID/interactions/:interactionID/reply", {
        params: { ...session, interactionID: Schema.String },
        payload: SessionExternal.Reply,
        success: SessionExternal.Snapshot,
        error: LabError,
      }).middleware(location),
    )
    .add(
      HttpApiEndpoint.post("lab.settings", "/lab/sessions/:sessionID/settings", {
        params: session,
        payload: SessionExternal.Settings,
        success: SessionExternal.Descriptor,
        error: LabError,
      }).middleware(location),
    )
    .annotateMerge(OpenApi.annotations({ title: "Lab", description: "Native session backends for the Lab workbench." }))
