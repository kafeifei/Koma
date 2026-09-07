import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { PollResult } from "./client"

type Fixture = typeof import("./app.fixture")

let fixture: Fixture
let output: string

before(async () => {
  output = await mkdtemp(path.join(tmpdir(), "opencode-remote-web-"))
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [solid()],
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.join(path.dirname(fileURLToPath(import.meta.url)), "app.fixture.ts"),
        formats: ["es"],
        fileName: "fixture",
      },
    },
  })
  fixture = (await import(pathToFileURL(path.join(output, "fixture.js")).href)) as Fixture
})

after(async () => {
  await rm(output, { recursive: true, force: true })
})

test("cancel waits for an in-flight poll before clearing its session", async () => {
  const originalSetTimeout = window.setTimeout
  const order: string[] = []
  let resolvePoll: (result: PollResult) => void = () => undefined
  const pollRequest = new Promise<PollResult>((resolve) => {
    resolvePoll = resolve
  })

  fixture.configure({
    session: async () => ({ signedIn: false as const, account: null, devices: [] }),
    login: async () => ({
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresAt: Date.now() + 60_000,
      interval: 1,
    }),
    poll: () => {
      order.push("poll")
      return pollRequest
    },
    logout: async () => {
      order.push("logout")
      return { signedIn: false as const }
    },
  })
  window.setTimeout = ((handler: TimerHandler) => {
    queueMicrotask(() => {
      if (typeof handler === "function") handler()
    })
    return 1
  }) as typeof window.setTimeout

  const mounted = fixture.mount()

  try {
    await until(() => mounted.root.querySelector(".remote-primary") !== null)
    click(mounted.root.querySelector(".remote-primary"))
    await until(() => order.includes("poll"))
    click([...mounted.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Cancel sign-in")))
    await Promise.resolve()
    assert.deepEqual(order, ["poll"])

    resolvePoll({
      status: "complete",
      account: { id: 1, name: "Ada", username: "ada" },
      devices: [{ id: "cluster/device", name: "should-not-appear", online: true, url: "https://x.devtunnels.ms" }],
    })
    await until(() => order.includes("logout"))
    await until(() => mounted.root.querySelector(".remote-primary") !== null)
    assert.deepEqual(order, ["poll", "logout"])
    assert.ok(!mounted.root.textContent?.includes("should-not-appear"))
  } finally {
    mounted.dispose()
    mounted.root.remove()
    window.setTimeout = originalSetTimeout
  }
})

test("cancel keeps the uncertain session visible when logout fails", async () => {
  const originalSetTimeout = window.setTimeout
  const order: string[] = []
  let resolvePoll: (result: PollResult) => void = () => undefined
  const pollRequest = new Promise<PollResult>((resolve) => {
    resolvePoll = resolve
  })

  fixture.configure({
    session: async () => ({ signedIn: false as const, account: null, devices: [] }),
    login: async () => ({
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresAt: Date.now() + 60_000,
      interval: 1,
    }),
    poll: () => {
      order.push("poll")
      return pollRequest
    },
    logout: async () => {
      order.push("logout")
      throw new Error("logout failed")
    },
  })
  window.setTimeout = ((handler: TimerHandler) => {
    queueMicrotask(() => {
      if (typeof handler === "function") handler()
    })
    return 1
  }) as typeof window.setTimeout

  const mounted = fixture.mount()

  try {
    await until(() => mounted.root.querySelector(".remote-primary") !== null)
    click(mounted.root.querySelector(".remote-primary"))
    await until(() => order.includes("poll"))
    click([...mounted.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Cancel sign-in")))
    await Promise.resolve()
    assert.deepEqual(order, ["poll"])

    resolvePoll({
      status: "complete",
      account: { id: 1, name: "Ada", username: "ada" },
      devices: [{ id: "cluster/device", name: "should-not-appear", online: true, url: "https://x.devtunnels.ms" }],
    })
    await until(() => order.includes("logout"))
    await until(() => mounted.root.querySelector("[role=alert]") !== null)
    assert.deepEqual(order, ["poll", "logout"])
    assert.ok(mounted.root.textContent?.includes("Remote access could not be loaded."))
    assert.equal(mounted.root.querySelector(".remote-primary"), null)
    assert.ok(!mounted.root.textContent?.includes("should-not-appear"))
  } finally {
    mounted.dispose()
    mounted.root.remove()
    window.setTimeout = originalSetTimeout
  }
})

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return
    await Promise.resolve()
  }
  assert.fail("condition was not reached")
}

function click(element: Element | undefined | null) {
  assert.ok(element instanceof HTMLElement)
  element.click()
}
