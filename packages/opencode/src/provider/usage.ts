export * as ProviderUsage from "./usage"

import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { ProviderUsage as Usage } from "@opencode-ai/schema/provider-usage"
import { Auth } from "../auth"
import { OpenAIAuth } from "../auth/openai"
import { accountId } from "../plugin/openai/oauth"

export interface Interface {
  readonly read: (providerID: string) => Effect.Effect<Usage.Info | null>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderUsage") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const credentials = yield* OpenAIAuth.Service
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const read = Effect.fn("ProviderUsage.read")(function* (providerID: string) {
        if (providerID !== "openai") return null
        // Credentials belong to the shared Provider, independently of the task's engine.
        const credential = yield* Effect.tryPromise(() => credentials.get())
        if (!credential) return null
        const before = yield* auth.snapshot(providerID)
        if (before.info?.type !== "oauth" || before.info.access !== credential.access) return null
        const id = accountId(credential)
        const request = HttpClientRequest.get("https://chatgpt.com/backend-api/wham/usage").pipe(
          HttpClientRequest.bearerToken(credential.access),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders(id ? { "ChatGPT-Account-Id": id } : {}),
        )
        const response = yield* http.execute(request)
        const payload = yield* response.json
        const after = yield* auth.snapshot(providerID)
        // Discard a response belonging to a previous login, even if token bytes match.
        if (
          after.revision !== before.revision ||
          after.info?.type !== "oauth" ||
          after.info.access !== credential.access
        )
          return null
        return fromOpenAI(payload)
      })
      return Service.of({
        read: (providerID) =>
          read(providerID).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", cache: "no-store" }),
            Effect.timeout("10 seconds"),
            Effect.orElseSucceed(() => null),
          ),
      })
    }),
  ),
  deps: [Auth.node, OpenAIAuth.node, httpClient],
})

export function fromOpenAI(input: unknown): Usage.Info | null {
  const data = record(input)
  if (!data) return null
  const windows: Usage.Window[] = []
  const add = (value: unknown, id: string, name?: string) => {
    const limits = record(value)
    if (!limits) return
    for (const key of ["primary_window", "secondary_window"]) {
      const window = record(limits[key])
      if (!window) continue
      const percent = nonnegative(window.used_percent)
      const duration = nonnegative(window.limit_window_seconds)
      const reset = nonnegative(window.reset_at)
      const resetsAt = reset !== undefined && reset > 0 && reset <= 8.64e12 ? reset * 1000 : undefined
      if (percent === undefined && resetsAt === undefined) continue
      windows.push({
        id: `${id}.${key}`,
        ...(name ? { name } : {}),
        ...(percent !== undefined ? { usedPercent: percent } : {}),
        ...(duration !== undefined && duration > 0 ? { durationSeconds: duration } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      })
    }
  }
  add(data.rate_limit, "usage")
  add(data.code_review_rate_limit, "code-review", "Code review")
  if (Array.isArray(data.additional_rate_limits)) {
    data.additional_rate_limits.forEach((value, index) => {
      const item = record(value)
      if (item) add(item.rate_limit, `additional.${index}`, label(item.limit_name))
    })
  }
  const plan = label(data.plan_type)
  const balance = record(data.credits)
  const credits = nonnegative(balance?.balance, true)
  const unlimited = balance?.unlimited === true
  if (!plan && !windows.length && credits === undefined && !unlimited) return null
  return {
    providerID: "openai",
    windows,
    ...(plan ? { plan } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(unlimited ? { unlimitedCredits: true } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function label(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function nonnegative(value: unknown, numericString = false) {
  const number = numericString && typeof value === "string" && value.trim() ? Number(value) : value
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined
}
