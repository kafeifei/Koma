import type { WebEntryState } from "./types"
import { createWebEntry } from "./web-entry"

export function createWebEntryController(
  options: Parameters<typeof createWebEntry>[0] & {
    settings: { get(key: string): unknown; set(key: string, value: unknown): void }
    changed(state: WebEntryState): void
    failed(error: unknown): void
  },
) {
  const settings = options.settings
  const port = settings.get("webEntryPort")
  const gateway = createWebEntry({
    ...options,
    preferredPort: typeof port === "number" ? port : undefined,
  })
  let state: WebEntryState = { enabled: settings.get("webEntryEnabled") !== false, url: null, error: false }
  let pending = Promise.resolve(state)
  let stopped = false

  const setEnabled = (enabled: boolean) => {
    pending = pending.then(async () => {
      if (stopped) return state
      settings.set("webEntryEnabled", enabled)
      const result = enabled
        ? await gateway.start().catch((error: unknown) => {
            options.failed(error)
            return undefined
          })
        : await gateway.stop().then(() => undefined)
      if (result) settings.set("webEntryPort", Number(new URL(result.url).port))
      state = { enabled, url: result?.url ?? null, error: enabled && !result }
      options.changed(state)
      return state
    })
    return pending
  }

  return {
    getState: async () => state,
    initialize: () => setEnabled(state.enabled),
    setEnabled,
    stop: async () => {
      stopped = true
      await pending
      await gateway.stop()
    },
  }
}
