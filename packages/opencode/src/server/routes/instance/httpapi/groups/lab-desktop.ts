import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"

// Koma desktop host contract, separate from upstream Session APIs.
export const LabDesktopApi = HttpApi.make("lab-desktop").add(
  HttpApiGroup.make("lab-desktop")
    .add(
      HttpApiEndpoint.post("computerUse", "/lab/desktop/computer-use", {
        payload: Schema.Union([
          Schema.Struct({ action: Schema.Literals(["status", "install", "start", "grant"]) }),
          Schema.Struct({ action: Schema.Literal("enable"), enabled: Schema.Boolean }),
          Schema.Struct({
            action: Schema.Literal("open-settings"),
            permission: Schema.Literals(["accessibility", "screenRecording"]),
          }),
        ]),
        success: Schema.Struct({
          supported: Schema.Boolean,
          device: Schema.String,
          platform: Schema.String,
          enabled: Schema.Boolean,
          installed: Schema.Boolean,
          version: Schema.optionalKey(Schema.String),
          running: Schema.Boolean,
          accessibility: Schema.NullOr(Schema.Boolean),
          screenRecording: Schema.NullOr(Schema.Boolean),
          busy: Schema.optionalKey(Schema.Literals(["install", "grant", "start"])),
          error: Schema.optionalKey(Schema.String),
        }),
        error: InvalidRequestError,
      }),
      HttpApiEndpoint.post("storage", "/lab/desktop/storage", {
        payload: Schema.Unknown,
        success: Schema.Unknown,
        error: InvalidRequestError,
      }),
      HttpApiEndpoint.post("services", "/lab/desktop/services", {
        payload: Schema.Unknown,
        success: Schema.Unknown,
        error: InvalidRequestError,
      }),
      HttpApiEndpoint.post("experiments", "/lab/desktop/experiments", {
        payload: Schema.Unknown,
        success: Schema.Unknown,
        error: InvalidRequestError,
      }),
      HttpApiEndpoint.post("draft", "/lab/desktop/draft", {
        payload: Schema.Unknown,
        success: Schema.Unknown,
        error: InvalidRequestError,
      }),
    )
    .middleware(Authorization),
)
