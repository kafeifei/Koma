export * as ProviderDiscovery from "./provider-discovery.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

/**
 * One provider's refresh: how many models its endpoint listed, or why the list could not be read. `status` is the
 * HTTP status when the endpoint answered with an error, so a client can tell a refused key from an outage.
 */
export interface Result extends Schema.Schema.Type<typeof Result> {}
export const Result = Schema.Struct({
  providerID: Schema.String,
  name: optional(Schema.String),
  models: optional(Schema.Number),
  error: optional(Schema.String),
  status: optional(Schema.Number),
}).annotate({ identifier: "ProviderDiscovery.Result" })

/**
 * Koma: the RPC of the plugin that lists the models of configured OpenAI-compatible providers from their own
 * `/models` endpoint. `refresh` reads every such provider's list again and answers once providers have reloaded.
 */
export const Definition = Rpc.define({
  id: "koma.provider-discovery",
  methods: {
    refresh: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Struct({ providers: Schema.Array(Result) })),
    },
  },
  events: {},
})
