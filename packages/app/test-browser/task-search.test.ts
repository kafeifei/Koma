import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createComponent, render } from "solid-js/web"
import { createStore } from "solid-js/store"
import type { ServerCtx } from "@/context/global"
import { createTaskSearch } from "@/pages/layout/task-search"

test("task search discards delayed results and separates archive scope", async () => {
  const queryClient = new QueryClient()
  const [state, setState] = createStore({ query: "", archived: false })
  const firstStarted = Promise.withResolvers<AbortSignal>()
  const secondStarted = Promise.withResolvers<void>()
  const first = Promise.withResolvers<{ data: { sessionID: string; directory: string; snippet: string }[] }>()
  const second = Promise.withResolvers<{ data: { sessionID: string; directory: string; snippet: string }[] }>()
  const context = {
    queryClient,
    sdk: {
      scope: "server-test",
      client: {
        experimental: {
          session: {
            search: async (input: { query: string; archived: boolean }, options: { signal: AbortSignal }) => {
              if (input.archived)
                return { data: { data: [{ sessionID: "archive", directory: "/repo", snippet: "archived" }] } }
              if (input.query === "first") {
                firstStarted.resolve(options.signal)
                return { data: await first.promise }
              }
              secondStarted.resolve()
              return { data: await second.promise }
            },
          },
        },
      },
    },
  } as unknown as ServerCtx
  const host = document.createElement("div")
  document.body.append(host)
  const View = () => {
    const search = createTaskSearch({
      context: () => context,
      query: () => state.query,
      archived: () => state.archived,
    })
    return () =>
      search
        .hits()
        .map((hit) => hit.sessionID)
        .join(",")
  }
  const dispose = render(
    () =>
      createComponent(QueryClientProvider, {
        client: queryClient,
        get children() {
          return createComponent(View, {})
        },
      }),
    host,
  )

  setState("query", "first")
  const signal = await firstStarted.promise
  setState("query", "second")
  expect(host.textContent).toBe("")
  await secondStarted.promise
  expect(signal.aborted).toBe(true)
  first.resolve({ data: [{ sessionID: "stale", directory: "/repo", snippet: "first" }] })
  second.resolve({ data: [{ sessionID: "current", directory: "/repo", snippet: "second" }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toBe("current")

  setState("archived", true)
  expect(host.textContent).not.toBe("current")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toBe("archive")
  setState("query", "")
  expect(host.textContent).toBe("")

  dispose()
  host.remove()
  queryClient.clear()
})
