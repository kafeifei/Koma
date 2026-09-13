import { Schema } from "effect"

export const PluginInput = Schema.Struct({
  spec: Schema.String,
  options: Schema.Record(Schema.String, Schema.Unknown),
})
export type PluginInput = typeof PluginInput.Type

export const PluginChange = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const PluginRuntime = Schema.Struct({
  directory: Schema.String,
  status: Schema.Literals(["loading", "active", "failed"]),
  error: Schema.optional(Schema.String),
  fingerprint: Schema.String,
})
export type PluginRuntime = typeof PluginRuntime.Type

export const PluginInfo = Schema.Struct({
  id: Schema.String,
  spec: Schema.String,
  catalogID: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  resourceKind: Schema.optional(Schema.Literals(["plugin", "instructions"])),
  version: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  managed: Schema.Boolean,
  pending: Schema.Boolean,
  runtime: Schema.Array(PluginRuntime),
})
export type PluginInfo = typeof PluginInfo.Type
export const PluginList = Schema.Array(PluginInfo)

export const IntegrationInfo = Schema.Struct({
  name: Schema.String,
  managed: Schema.Boolean,
  enabled: Schema.Boolean,
  config: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.String,
  error: Schema.optional(Schema.String),
})
export type IntegrationInfo = typeof IntegrationInfo.Type
export const IntegrationList = Schema.Array(IntegrationInfo)

export const CatalogEntry = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["plugin", "mcp", "project", "agent"]),
  name: Schema.String,
  description: Schema.String,
  descriptionZh: Schema.optional(Schema.String),
  url: Schema.String,
  sourceUrl: Schema.String,
  // Installation recipes are reviewed separately from the upstream directory.
  plugin: Schema.optional(Schema.Struct({ spec: Schema.String, verifiedAt: Schema.String })),
  installation: Schema.optional(
    Schema.Struct({
      type: Schema.Literals(["npm", "files", "instructions", "builtin", "external"]),
      verifiedAt: Schema.optional(Schema.String),
      note: Schema.optional(Schema.String),
      noteZh: Schema.optional(Schema.String),
    }),
  ),
  mcp: Schema.optional(Schema.Struct({ name: Schema.String, url: Schema.String, oauth: Schema.Boolean })),
})
export type CatalogEntry = typeof CatalogEntry.Type
export const ExtensionCatalog = Schema.Struct({
  entries: Schema.Array(CatalogEntry),
  fetchedAt: Schema.String,
  origin: Schema.Literals(["bundled", "cache", "remote"]),
  warning: Schema.optional(Schema.String),
})
export type ExtensionCatalog = typeof ExtensionCatalog.Type
