import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { PluginInput, PluginChange, PluginList, IntegrationList } from "@opencode-ai/schema/koma-extensions"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"

export class ExtensionError extends Schema.ErrorClass<ExtensionError>("ExtensionError")(
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class ExtensionBusyError extends Schema.ErrorClass<ExtensionBusyError>("ExtensionBusyError")(
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}
export const IntegrationInput = Schema.Struct({ name: Schema.String, config: ConfigMCPV1.Info })
const id = { id: Schema.String }
const name = { name: Schema.String }
export const PluginsApi = HttpApi.make("koma-plugins").add(
  HttpApiGroup.make("koma-plugins").add(
    HttpApiEndpoint.get("list", "/global/extensions/plugins", { success: PluginList, error: ExtensionError }),
    HttpApiEndpoint.post("install", "/global/extensions/plugins", {
      payload: PluginInput,
      success: PluginList,
      error: ExtensionError,
    }),
    HttpApiEndpoint.patch("change", "/global/extensions/plugins", {
      payload: PluginChange,
      success: PluginList,
      error: ExtensionError,
    }),
    HttpApiEndpoint.delete("remove", "/global/extensions/plugins/:id", {
      params: id,
      success: PluginList,
      error: ExtensionError,
    }),
  ),
)
export const IntegrationsApi = HttpApi.make("koma-integrations").add(
  HttpApiGroup.make("koma-integrations")
    .add(
      HttpApiEndpoint.get("list", "/extensions/integrations", {
        query: WorkspaceRoutingQuery,
        success: IntegrationList,
        error: ExtensionError,
      }),
      HttpApiEndpoint.put("save", "/extensions/integrations", {
        query: WorkspaceRoutingQuery,
        payload: IntegrationInput,
        success: IntegrationList,
        error: [ExtensionError, ExtensionBusyError],
      }),
      HttpApiEndpoint.delete("remove", "/extensions/integrations/:name", {
        query: WorkspaceRoutingQuery,
        params: name,
        success: IntegrationList,
        error: [ExtensionError, ExtensionBusyError],
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
