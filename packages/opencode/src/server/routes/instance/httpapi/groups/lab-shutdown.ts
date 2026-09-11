import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"
import { Authorization } from "../middleware/authorization"

// Desktop lifecycle endpoint. Keep it outside the public SDK API composition.
export const LabShutdownApi = HttpApi.make("lab-shutdown").add(
  HttpApiGroup.make("lab-shutdown")
    .add(
      HttpApiEndpoint.get("state", "/lab/shutdown-state", {
        success: Schema.Struct({ active: Schema.Boolean }),
        error: ServiceUnavailableError,
      }),
    )
    .middleware(Authorization),
)
