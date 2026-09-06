import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createApiForServer, createSdkForServer } from "@/utils/server"
import { createCompatibleApi, sessionCapabilities } from "@/utils/server-compat"
import { createSessionCapabilities } from "@/utils/session-capabilities"

const capabilities = (archive = true) => ({
  archive,
  restore: archive,
  delete: archive,
  managedWorktree: archive,
  occupancy: { pty: archive, v2: archive, externalProcesses: false },
})
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(reply: (attempt: number) => Response | Promise<Response>) {
  let requests = 0
  const server = { url: "http://capabilities.test" }
  const fetcher = Object.assign(async () => reply(++requests), { preconnect: globalThis.fetch.preconnect })
  const api = createCompatibleApi({
    protocol: Promise.resolve("v2"),
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: () => createSdkForServer({ server, fetch: fetcher }),
  })
  return { api, requests: () => requests }
}

test("Home and session resources recover when a menu retries their failed shared capability request", async () => {
  const fixture = setup((attempt) =>
    attempt === 1
      ? Response.json({ message: "temporary failure" }, { status: 503 })
      : Response.json({ data: capabilities() }),
  )
  const views = createRoot((dispose) => ({
    home: createSessionCapabilities(() => fixture.api),
    session: createSessionCapabilities(() => fixture.api),
    dispose,
  }))
  try {
    await settle()
    expect(views.home()).toBeUndefined()
    expect(views.session()).toBeUndefined()
    expect(fixture.requests()).toBe(1)
    await sessionCapabilities(fixture.api)
    await settle()
    expect(views.home()?.archive).toBe(true)
    expect(views.session()?.archive).toBe(true)
    expect(fixture.requests()).toBe(2)
  } finally {
    views.dispose()
  }
})

test("window focus retries failed resources once and broadcasts explicit unsupported capabilities", async () => {
  const fixture = setup((attempt) =>
    attempt === 1
      ? Response.json({ message: "temporary failure" }, { status: 503 })
      : Response.json({ data: capabilities(false) }),
  )
  const views = createRoot((dispose) => ({
    home: createSessionCapabilities(() => fixture.api),
    session: createSessionCapabilities(() => fixture.api),
    dispose,
  }))
  try {
    await settle()
    expect(views.home()).toBeUndefined()
    window.dispatchEvent(new Event("focus"))
    await settle()
    expect(views.home()?.archive).toBe(false)
    expect(views.session()?.archive).toBe(false)
    expect(fixture.requests()).toBe(2)
    window.dispatchEvent(new Event("focus"))
    await settle()
    expect(fixture.requests()).toBe(2)
  } finally {
    views.dispose()
  }
})

test("switching servers clears old capabilities and ignores a late response from the prior server", async () => {
  const first = Promise.withResolvers<Response>()
  const one = setup(() => first.promise)
  const two = setup(() => Response.json({ data: capabilities(false) }))
  const view = createRoot((dispose) => {
    const [api, setApi] = createSignal(one.api)
    return { capabilities: createSessionCapabilities(api), setApi, dispose }
  })
  try {
    await settle()
    view.setApi(two.api)
    expect(view.capabilities()).toBeUndefined()
    await settle()
    expect(view.capabilities()?.archive).toBe(false)
    first.resolve(Response.json({ data: capabilities() }))
    await settle()
    expect(view.capabilities()?.archive).toBe(false)
  } finally {
    view.dispose()
  }
})

test("disposed resources unsubscribe from shared success and focus retries", async () => {
  const fixture = setup((attempt) =>
    attempt === 1
      ? Response.json({ message: "temporary failure" }, { status: 503 })
      : Response.json({ data: capabilities() }),
  )
  const view = createRoot((dispose) => ({ capabilities: createSessionCapabilities(() => fixture.api), dispose }))
  await settle()
  expect(view.capabilities()).toBeUndefined()
  view.dispose()
  window.dispatchEvent(new Event("focus"))
  await settle()
  expect(fixture.requests()).toBe(1)
  await sessionCapabilities(fixture.api)
  await settle()
  expect(view.capabilities()).toBeUndefined()
})
