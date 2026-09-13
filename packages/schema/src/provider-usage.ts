export * as ProviderUsage from "./provider-usage"

import { Schema } from "effect"
import { optional } from "./schema"

export const Window = Schema.Struct({
  id: Schema.String,
  name: Schema.String.pipe(optional),
  usedPercent: Schema.Finite.pipe(optional),
  durationSeconds: Schema.Finite.pipe(optional),
  resetsAt: Schema.Finite.annotate({ description: "Reset time as Unix milliseconds" }).pipe(optional),
}).annotate({ identifier: "ProviderUsage.Window" })
export interface Window extends Schema.Schema.Type<typeof Window> {}

export const Info = Schema.Struct({
  providerID: Schema.String,
  plan: Schema.String.pipe(optional),
  windows: Schema.Array(Window),
  credits: Schema.Finite.pipe(optional),
  unlimitedCredits: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "ProviderUsage.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Result = Schema.Struct({ usage: Info.pipe(optional) }).annotate({ identifier: "ProviderUsage.Result" })
