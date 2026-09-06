import type { LabSnapshotOutput } from "@opencode-ai/lab-client"

type Snapshot = Pick<LabSnapshotOutput, "usage" | "contextTokens" | "contextWindow" | "cost">

export function getExternalSessionMetrics(snapshot?: Snapshot) {
  const tokens = available(snapshot?.usage)
  const current = available(snapshot?.contextTokens)
  const limit = available(snapshot?.contextWindow)
  return {
    tokens,
    current,
    limit,
    usage: current !== undefined && limit !== undefined && limit > 0 ? Math.round((current / limit) * 100) : undefined,
    cost: available(snapshot?.cost),
  }
}

function available<A>(value?: { status: "available"; value: A } | { status: "unavailable" | "loading" }) {
  return value?.status === "available" ? value.value : undefined
}
