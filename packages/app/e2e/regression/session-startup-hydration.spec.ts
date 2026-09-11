import { base64Encode } from "@opencode-ai/core/util/encode"
import type { LabDescribeOutput, LabSnapshotOutput } from "@opencode-ai/lab-client"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "/tmp/opencode-lab-startup-hydration"
const sessionID = "ses_codex_startup_hydration"
const title = "Saved startup task"
const epoch = "codex-startup-hydration"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const capabilities = {
  prompt: true,
  steer: true,
  queue: "host" as const,
  compact: false,
  images: true,
  permissions: true,
}

test("hydrates a saved task after its initial native snapshot finishes", async ({ page }) => {
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let snapshotReads = 0
  await setup(page)
  await page.route("**/lab/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/lab/sessions/describe") return json(route, [descriptor(0, "resolving")])
    if (path === `/lab/sessions/${sessionID}`) {
      snapshotReads++
      requested.resolve()
      await release.promise
      return json(route, snapshot(1))
    }
    return route.fallback()
  })

  await page.goto(sessionHref())
  await requested.promise
  try {
    await expect(page.locator('[data-slot="titlebar-tab-item"]')).toContainText(title)
    await expect(page.getByRole("button", { name: "Toggle review" })).toBeVisible()
    await expect(page.locator('[data-slot="session-loading"]')).toHaveText("Loading...")
    await expect(page.locator('[data-slot="session-title-child"]')).toHaveCount(0)
    await expect(page.getByText("Recovered native history", { exact: true })).toHaveCount(0)
  } finally {
    release.resolve()
  }

  await expect(page.locator('[data-slot="session-loading"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="session-title-child"]')).toHaveText(title)
  await expect(page.getByText("Recovered native history", { exact: true })).toBeVisible()
  expect(snapshotReads).toBe(1)
})

test("keeps a failed native startup snapshot actionable", async ({ page }) => {
  await setup(page)
  await page.route("**/lab/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/lab/sessions/describe") return json(route, [descriptor(0, "resolving")])
    if (path === `/lab/sessions/${sessionID}`) return json(route, failedSnapshot())
    return route.fallback()
  })

  await page.goto(sessionHref())

  await expect(page.getByRole("button", { name: "Toggle review" })).toBeVisible()
  await expect(page.getByText("Native runtime was not ready", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="session-loading"]')).toHaveCount(0)
})

test("keeps the session header when the native snapshot request fails", async ({ page }) => {
  let snapshotReads = 0
  await setup(page)
  await page.route("**/lab/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/lab/sessions/describe") return json(route, [descriptor(0, "resolving")])
    if (path === `/lab/sessions/${sessionID}`) {
      snapshotReads++
      return json(route, { error: "Native snapshot request failed" }, 500)
    }
    return route.fallback()
  })

  await page.goto(sessionHref())

  await expect(page.getByRole("button", { name: "Toggle review" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="session-loading"]')).toHaveCount(0)
  expect(snapshotReads).toBe(1)
})

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: { id: "startup-hydration", worktree: directory, vcs: "git", time: {}, sandboxes: [] },
    sessions: [
      {
        id: sessionID,
        engine: "codex",
        projectID: "startup-hydration",
        directory,
        title,
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      },
    ],
    provider: { all: [], connected: [], default: {} },
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ server, directory, sessionID, title, href }) => {
      const tab = { type: "session", server, sessionId: sessionID }
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [server],
          projects: { [server]: [{ worktree: directory, expanded: true }] },
          lastProject: { [server]: directory },
        }),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify([tab]))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs.info",
        JSON.stringify({ [`${server}\n${href}`]: { title, directory } }),
      )
    },
    { server, directory, sessionID, title, href: sessionHref() },
  )
}

function sessionHref() {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

function descriptor(
  revision: number,
  runtimeStatus: "resolving" | "idle" | "bindingUnavailable",
): LabDescribeOutput[number] {
  return {
    sessionID,
    engine: "codex",
    epoch,
    revision,
    runtimeStatus,
    bindingState: runtimeStatus === "bindingUnavailable" ? "failed" : "bound",
    capabilities,
    queuePaused: false,
    settings: {},
    ...(runtimeStatus === "bindingUnavailable" ? { error: "Native runtime was not ready" } : {}),
  }
}

function failedSnapshot(): LabSnapshotOutput {
  return {
    ...snapshot(1),
    descriptor: descriptor(1, "bindingUnavailable"),
    messages: [],
    messageOrder: [],
    partOrder: {},
  }
}

function snapshot(revision: number): LabSnapshotOutput {
  const userID = "msg_codex_startup_user"
  const assistantID = "msg_codex_startup_assistant"
  const partID = "prt_codex_startup_assistant"
  return {
    descriptor: descriptor(revision, "idle"),
    messages: [
      {
        id: userID,
        type: "user",
        text: "Restore this task",
        metadata: { codex: { turnID: "turn-startup" } },
        orderKey: "codex_startup_0001",
        time: { created: 1_700_000_000_000 },
      },
      {
        id: assistantID,
        type: "assistant",
        orderKey: "codex_startup_0002",
        time: { created: 1_700_000_001_000 },
        streaming: false,
        agent: "codex",
        model: { providerID: "codex", id: "gpt-6" },
        content: [{ id: partID, type: "text", text: "Recovered native history" }],
      },
    ],
    messageOrder: [userID, assistantID],
    partOrder: { [assistantID]: [partID] },
    interactions: [],
    deliveries: [],
    usage: { status: "unavailable" },
    contextTokens: { status: "unavailable" },
    contextWindow: { status: "unavailable" },
    cost: { status: "unavailable" },
    turnDiffs: {},
    sessionDiff: { status: "unavailable" },
    children: [],
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}
