import { KomaExperiments } from "@opencode-ai/core/koma-experiments"
import type { BackendExperimentsPlatform } from "@opencode-ai/app/backend-experiments"
import type { ServerReadyData } from "../preload/types"

export function createBackendExperiments(input: {
  root: string
  backend: () => Promise<ServerReadyData>
}): BackendExperimentsPlatform {
  const getState = async () => {
    const saved = KomaExperiments.read(input.root)
    const running = await input
      .backend()
      .then(async (backend) => {
        const response = await fetch(new URL("/experimental/capabilities", backend.url), {
          headers:
            backend.username && backend.password
              ? { Authorization: `Basic ${Buffer.from(`${backend.username}:${backend.password}`).toString("base64")}` }
              : {},
          signal: AbortSignal.timeout(3_000),
        })
        if (!response.ok) return null
        const value: unknown = await response.json()
        return value &&
          typeof value === "object" &&
          "backgroundSubagents" in value &&
          typeof value.backgroundSubagents === "boolean"
          ? value.backgroundSubagents
          : null
      })
      .catch(() => null)
    return {
      backgroundSubagents: saved.backgroundSubagents ?? running ?? false,
      runningBackgroundSubagents: running,
    }
  }
  return {
    getState,
    async setBackgroundSubagents(enabled) {
      await KomaExperiments.setBackgroundSubagents(input.root, enabled)
      return getState()
    },
  }
}
