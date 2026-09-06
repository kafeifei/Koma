import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { Session, SessionV2Info } from "@opencode-ai/sdk/v2/client"
import { createComponent, render } from "solid-js/web"
import type { ServerCtx } from "@/context/global"
import { createHomeSessionIndexCache } from "@/context/global-sync/home-session-index"
import { createHomeSessionQuery } from "@/context/global-sync/home-session-query"

const legacySession = (id: string, title: string): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/repo",
  title,
  version: "",
  time: { created: 1, updated: 1 },
})

const v2Session = (id: string, title: string): SessionV2Info => ({
  id,
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title,
  location: { directory: "/repo" },
})

test("home session query observes events from its cache owner across query providers", async () => {
  const cacheClient = new QueryClient()
  const routeClient = new QueryClient()
  const cache = createHomeSessionIndexCache(cacheClient, "server")
  let requests = 0
  const context = {
    sync: { homeSessions: cache },
    sdk: {
      client: {
        v2: {
          session: {
            list: async () => {
              requests++
              return { data: { data: [v2Session("initial", "Initial")], cursor: {} } }
            },
          },
        },
      },
    },
  } as unknown as ServerCtx
  const host = document.createElement("div")
  document.body.append(host)

  const View = () => {
    const query = createHomeSessionQuery(() => context)
    return () =>
      query
        .sessions()
        .map((session) => `${session.id}:${session.title}`)
        .join("|")
  }
  const dispose = render(
    () =>
      createComponent(QueryClientProvider, {
        client: routeClient,
        get children() {
          return createComponent(View, {})
        },
      }),
    host,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(host.textContent).toBe("initial:Initial")
  expect(requests).toBe(1)
  cache.apply({
    type: "session.created",
    properties: { sessionID: "created", info: legacySession("created", "Created") },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toBe("initial:Initial|created:Created")

  cache.apply({
    type: "session.updated",
    properties: { sessionID: "created", info: legacySession("created", "Renamed") },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.textContent).toBe("initial:Initial|created:Renamed")
  expect(requests).toBe(1)

  dispose()
  host.remove()
  cacheClient.clear()
  routeClient.clear()
})
