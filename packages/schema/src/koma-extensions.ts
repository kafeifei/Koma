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
