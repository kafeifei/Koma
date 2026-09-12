export * as CodexProviders from "./providers"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

export type Model = {
  id: string
  modelID?: string
  executionID?: string
  serviceTier?: string
  name: string
  efforts: string[]
  defaultEffort?: string
  contextWindow?: number
}

export type Provider = {
  id: string
  name: string
  baseURL: string
  accountID?: string
  models: Model[]
}

export interface Interface {
  readonly list: () => Promise<Provider[]>
  // Resolve at request time, and refuse credentials if the configured endpoint
  // changed since the native thread selected this provider.
  readonly key: (providerID: string, baseURL: string, accountID?: string) => Promise<string | undefined>
  readonly onChange: (listener: () => void) => () => void
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodexProviders") {}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.succeed(Service, {
    list: async () => [],
    key: async () => undefined,
    onChange: () => () => {},
  }),
  deps: [],
})

export function modelID(providerID: string, model: string) {
  return `${providerID}/${model}`
}

export function nativeProviderID(providerID: string, executionID?: string) {
  return executionID
    ? `koma_model_${Buffer.from(JSON.stringify([providerID, executionID])).toString("hex")}`
    : `opencode_${providerID}`
}

export function observedModel(model: string | undefined | null, providerID: string | undefined | null) {
  if (providerID?.startsWith("koma_model_")) {
    try {
      const [provider, execution] = JSON.parse(Buffer.from(providerID.slice("koma_model_".length), "hex").toString())
      if (typeof provider === "string" && typeof execution === "string") return modelID(provider, execution)
    } catch {}
  }
  if (!model || !providerID?.startsWith("opencode_")) return model ?? undefined
  return modelID(providerID.slice("opencode_".length), model)
}
