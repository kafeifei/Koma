import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"
import type { LabSnapshotOutput, LabEnginesOutput } from "@opencode-ai/lab-client"
import { getSessionContext } from "./session-context-metrics"
import { getExternalSessionMetrics } from "./session-external-metrics"

export type SessionUsageMetrics = {
  providerID?: string
  current?: number
  limit?: number
  percent?: number
  cost?: number
}

export function getSessionUsageMetrics(input: {
  external: boolean
  snapshot?: LabSnapshotOutput
  model?: string
  engines?: LabEnginesOutput
  messages: Message[]
  providers: Parameters<typeof getSessionContext>[1]
  cost?: number
}): SessionUsageMetrics {
  if (input.external) {
    const metrics = getExternalSessionMetrics(input.snapshot)
    const model = input.engines
      ?.find((engine) => engine.id === "codex")
      ?.models.find((model) => model.id === input.model)
    return normalize({ ...metrics, providerID: model?.provider?.id })
  }
  const context = getSessionContext(input.messages, input.providers)
  const latest = input.messages.findLast((message): message is AssistantMessage => message.role === "assistant")
  return normalize({
    providerID: context?.message.providerID ?? latest?.providerID,
    current: context?.current,
    limit: context?.limit,
    // Legacy cost=0 also represents unknown pricing (including OAuth). It cannot establish a free request.
    cost: input.cost !== undefined && input.cost > 0 ? input.cost : undefined,
  })
}

function normalize(metrics: SessionUsageMetrics): SessionUsageMetrics {
  const current = finite(metrics.current)
  const limit = finite(metrics.limit)
  return {
    providerID: metrics.providerID,
    current,
    limit: limit !== undefined && limit > 0 ? limit : undefined,
    percent:
      current !== undefined && limit !== undefined && limit > 0 ? Math.round((current / limit) * 100) : undefined,
    cost: finite(metrics.cost),
  }
}

function finite(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}
