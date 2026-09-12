import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"

// Koma desktop host contract, separate from upstream Session APIs.
export const LabDesktopApi = HttpApi.make("lab-desktop").add(
  HttpApiGroup.make("lab-desktop")
    .add(
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
