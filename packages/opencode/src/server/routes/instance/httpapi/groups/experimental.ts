import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { WorktreeBranch } from "@/worktree/branch"
import { WorktreeMerge } from "@/worktree/merge"
import { WorktreeManager } from "@/worktree/manager"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
  Schema.Literal("WorktreeCheckoutFailedError"),
  Schema.Literal("WorktreeMergeFailedError"),
  Schema.Literal("WorktreeManagerFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})
export const SessionSearchQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  query: Schema.String.check(
    Schema.makeFilter((value) => (value.trim().length > 0 ? undefined : "Expected a non-empty search query")),
  ),
  archived: Schema.optional(QueryBoolean),
  cursor: Schema.optional(Session.SearchCursor),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
})

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  worktreeCheckout: "/experimental/worktree/checkout",
  worktreeOptions: "/experimental/worktree/options",
  worktreeStatus: "/experimental/session/:sessionID/worktree",
  session: "/experimental/session",
  sessionSearch: "/experimental/session/search",
  sessionBackground: "/experimental/session/:sessionID/background",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.get("worktreeOptions", ExperimentalPaths.worktreeOptions, {
          query: WorkspaceRoutingQuery,
          success: described(Worktree.Options, "Worktree creation options"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.options",
            summary: "Get worktree options",
            description: "Get local branch choices and the default base without fetching or changing the repository.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCheckout", ExperimentalPaths.worktreeCheckout, {
          query: WorkspaceRoutingQuery,
          payload: WorktreeBranch.CheckoutInput,
          success: described(WorktreeBranch.CheckoutResult, "Current local branch"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.checkout",
            summary: "Checkout local branch",
            description:
              "Switch the selected checkout to an existing local branch while preserving working tree changes.",
          }),
        ),
        HttpApiEndpoint.get("worktreeStatus", ExperimentalPaths.worktreeStatus, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Worktree.LifecycleStatus, "Session worktree lifecycle status"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.status",
            summary: "Get session worktree status",
            description: "Inspect an explicitly managed session worktree's archive or recovery state.",
          }),
        ),
        HttpApiEndpoint.post("worktreeMergePreview", "/experimental/worktree/merge/preview", {
          query: WorkspaceRoutingQuery,
          payload: WorktreeMerge.Input,
          success: WorktreeMerge.Preview,
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.mergePreview",
            summary: "Preview worktree merge",
            description:
              "Compare linked worktree results with the clean primary checkout without changing either checkout.",
          }),
        ),
        HttpApiEndpoint.get("worktreeManaged", "/experimental/worktree/managed", {
          query: WorkspaceRoutingQuery,
          success: WorktreeManager.ListResult,
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({ identifier: "worktree.managed", summary: "List worktree ownership and usage" }),
        ),
        HttpApiEndpoint.post("worktreeDetails", "/experimental/worktree/details", {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ directory: Schema.String }),
          success: WorktreeManager.DetailsResult,
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({ identifier: "worktree.details", summary: "Inspect worktree files and space" }),
        ),
        HttpApiEndpoint.post("worktreeAdopt", "/experimental/worktree/adopt", {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ directory: Schema.String, sessionID: Schema.optional(Schema.String) }),
          success: WorktreeManager.AdoptResult,
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({ identifier: "worktree.adopt", summary: "Explicitly adopt a linked worktree" }),
        ),
        HttpApiEndpoint.post("worktreeMergeApply", "/experimental/worktree/merge/apply", {
          query: WorkspaceRoutingQuery,
          payload: WorktreeMerge.ApplyInput,
          success: Schema.Boolean,
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.mergeApply",
            summary: "Apply reviewed worktree merge",
            description:
              "Stage a conflict-free, unchanged preview in the primary checkout. Does not commit or move branch references.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.get("sessionSearch", ExperimentalPaths.sessionSearch, {
          query: SessionSearchQuery,
          success: described(Session.SearchPage, "Session search results"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.search",
            summary: "Search sessions",
            description: "Search session titles and visible text across projects, filtered by archive state.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
