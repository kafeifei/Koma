import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { createInfiniteQuery } from "@tanstack/solid-query"
import type { ServerCtx } from "@/context/global"

export function createTaskSearch(input: {
  context: Accessor<ServerCtx>
  query: Accessor<string>
  archived: Accessor<boolean>
}) {
  const [state, setState] = createStore({ query: "" })
  createEffect(() => {
    const query = input.query().trim()
    if (!query) {
      setState("query", "")
      return
    }
    const timer = setTimeout(() => setState("query", query), 250)
    onCleanup(() => clearTimeout(timer))
  })
  const result = createInfiniteQuery(
    () => ({
      queryKey: ["task-search", input.context().sdk.scope, state.query, input.archived()],
      enabled: !!state.query && state.query === input.query().trim(),
      initialPageParam: undefined as string | undefined,
      queryFn: async ({ pageParam, signal }) => {
        const response = await input.context().sdk.client.experimental.session.search(
          {
            query: state.query,
            archived: input.archived(),
            limit: 50,
            cursor: pageParam,
          },
          { signal },
        )
        return response.data!
      },
      getNextPageParam: (page) => page.cursor,
      retry: false,
      staleTime: 10_000,
    }),
    () => input.context().queryClient,
  )
  const current = () => !!state.query && state.query === input.query().trim()
  return {
    hits: () => (current() ? (result.data?.pages.flatMap((page) => page.data) ?? []) : []),
    loading: () => !!input.query().trim() && (!current() || result.isFetching),
    error: () => (current() ? result.error : undefined),
    more: () => current() && result.hasNextPage,
    next: () => result.fetchNextPage(),
    retry: () => result.refetch(),
  }
}
