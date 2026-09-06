import type { Accessor } from "solid-js"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { ServerCtx } from "@/context/global"
import { loadHomeSessionIndex, type HomeSessionEvents } from "./home-session-index"

// Home and the persistent sidebar observe the same index and event overlay.
// Keep the fetch watermark with the server that started it when navigation changes servers.
export function createHomeSessionQuery(context: Accessor<ServerCtx | undefined>) {
  // The server's event listener owns this cache; nested route providers may use another client.
  const fallback = useQueryClient()
  const client = () => context()?.sync.homeSessions.queryClient ?? fallback
  const events = useQuery(
    () => ({
      queryKey: context()?.sync.homeSessions.eventsKey ?? ["home", "session-events", null],
      queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
      initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
      enabled: false,
    }),
    client,
  )
  const index = useQuery(
    () => ({
      queryKey: context()?.sync.homeSessions.indexKey ?? ["home", "session-index", null],
      enabled: !!context(),
      queryFn: async ({ signal }) => {
        const ctx = context()
        if (!ctx) return { sessions: [], eventSequence: 0 }
        const cache = ctx.sync.homeSessions
        const sequence = cache.eventSequence()
        const result = await loadHomeSessionIndex(
          (input, options) => ctx.sdk.client.v2.session.list(input, options),
          sequence,
          signal,
        )
        cache.complete(sequence)
        return result
      },
      retry: false,
      staleTime: 30_000,
      refetchOnMount: true,
      refetchOnReconnect: true,
    }),
    client,
  )

  return {
    sessions: () => context()?.sync.homeSessions.sessions(index.data, events.data) ?? [],
    archived: () => context()?.sync.homeSessions.sessions(index.data, events.data, true) ?? [],
    loading: () => index.isLoading,
    error: () => index.error,
    refetch: () => index.refetch(),
  }
}
