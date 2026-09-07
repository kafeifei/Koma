import { base64Encode } from "@opencode-ai/core/util/encode"
import type { LabCreateInput, LabDescribeOutput, LabEnginesOutput, LabSnapshotOutput } from "@opencode-ai/lab-client"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "/tmp/opencode-lab-codex-composer"
const otherDirectory = "/tmp/opencode-lab-codex-composer-b"
const projectID = "project-codex-composer"
const sessionID = "ses_codex_composer"
const createdSessionID = "ses_codex_created"
const draftA = `input:${base64Encode(JSON.stringify(["local", directory]))}`
const draftB = `input:${base64Encode(JSON.stringify(["local", otherDirectory]))}`
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const draftHref = (id: string) => `/new-session?draftId=${encodeURIComponent(id)}`
const sessionHref = `/${base64Encode(directory)}/session/${sessionID}`
const capabilities = {
  prompt: true,
  steer: true,
  queue: "host" as const,
  compact: false,
  images: true,
  permissions: true,
}

test("keeps Codex settings and text with their draft and preserves a rejected first send", async ({ page }) => {
  const backend = await setup(page)
  await page.goto(draftHref(draftA))
  await expect(page.locator('[data-component="prompt-engine-label"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-engine"]')).toBeVisible()
  const editor = page.locator('[data-component="prompt-input"]')
  await editor.fill("Keep Codex draft A")
  await choose(page, "prompt-engine", "Codex")
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toContainText("Native default")
  await choose(page, "prompt-codex-model", "GPT-5.6-Luna")
  await choose(page, "prompt-codex-effort", "high")
  await choose(page, "prompt-codex-permission", "Full access")
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toContainText("Full access")
  await page.goto(draftHref(draftB))
  await expect(page).toHaveURL(new URL(draftHref(draftB), page.url()).href)
  await expect(page.locator('[data-action="prompt-engine"]')).toContainText("Codex")
  await choose(page, "prompt-engine", "OpenCode")
  await expect(page.locator('[data-action="prompt-engine"]')).toContainText("OpenCode")
  await expect(editor).toHaveText("")
  await editor.fill("Keep OpenCode draft B")

  await page.goto(draftHref(draftA))
  await expect(page).toHaveURL(new URL(draftHref(draftA), page.url()).href)
  await expect(editor).toHaveText("Keep Codex draft A")
  await expect(page.locator('[data-action="prompt-engine"]')).toContainText("Codex")
  await expect(page.locator('[data-action="prompt-codex-model"]')).toContainText("GPT-5.6-Luna")
  await expect(page.locator('[data-action="prompt-codex-effort"]')).toContainText("high")
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toContainText("Full access")

  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(editor).toHaveText("Keep Codex draft A")
  await expect(page).toHaveURL(new URL(draftHref(draftA), page.url()).href)
  expect(backend.legacyCreates).toBe(0)
  expect(backend.nativeCreates).toHaveLength(1)
  expect(backend.nativeCreates[0]).toMatchObject({
    engine: "codex",
    location: { directory },
    delivery: "steer",
    input: {
      prompt: { text: "Keep Codex draft A", files: [] },
      settings: { model: "gpt-5.6-luna", effort: "high", permission: "full" },
    },
  })
})

test("restores Codex settings across refresh, project inputs and a successful first send", async ({ page }) => {
  const backend = await setup(page, { acceptCreate: true })
  await page.goto(draftHref(draftA))
  const editor = page.locator('[data-component="prompt-input"]')
  await choose(page, "prompt-engine", "Codex")
  await choose(page, "prompt-codex-model", "GPT-5.6-Luna")
  await choose(page, "prompt-codex-effort", "high")
  await choose(page, "prompt-codex-permission", "Full access")
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("opencode.global.dat:composer-preferences") ?? "{}") as {
          target?: Record<string, { codex?: { permission?: string } }>
        }
        return Object.values(saved.target ?? {}).some((item) => item.codex?.permission === "full")
      }),
    )
    .toBe(true)
  await page.reload()
  await expect(page.locator('[data-action="prompt-engine"]')).toContainText("Codex")
  await expect(page.locator('[data-action="prompt-codex-model"]')).toContainText("GPT-5.6-Luna")
  await expect(page.locator('[data-action="prompt-codex-effort"]')).toContainText("high")
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toContainText("Full access")

  await page.goto(draftHref(draftB))
  await expect(page.locator('[data-action="prompt-engine"]')).toContainText("Codex")
  await expect(page.locator('[data-action="prompt-codex-model"]')).toContainText("GPT-5.6-Luna")
  await expect(page.locator('[data-action="prompt-codex-effort"]')).toContainText("high")
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toContainText("Full access")
  await page.goto(draftHref(draftA))
  await editor.fill("Create remembered Codex task")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Created Codex task", exact: true })).toBeVisible()
  expect(backend.nativeCreates).toHaveLength(1)
  expect(backend.nativeCreates[0]).toMatchObject({
    engine: "codex",
    input: {
      settings: { model: "gpt-5.6-luna", effort: "high", permission: "full" },
    },
  })

  await page
    .locator(`[data-slot="workspace-project"][data-directory="${directory}"]`)
    .getByRole("button", { name: "New task", exact: true })
    .click()
  await expect(page).toHaveURL(new URL(draftHref(draftA), page.url()).href)
  await expect(page.locator('[data-action="prompt-engine"]')).toContainText("Codex")
  await expect(page.locator('[data-action="prompt-codex-model"]')).toContainText("GPT-5.6-Luna")
  await expect(page.locator('[data-action="prompt-codex-effort"]')).toContainText("high")
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toContainText("Full access")
})

test("leaves the OpenCode composer unchanged when the server does not advertise Codex", async ({ page }) => {
  await setup(page, { advertiseCodex: false })
  await page.goto(draftHref(draftA))

  await expect(page.locator('[data-action="prompt-engine"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-model"]')).toBeVisible()
  await expect(page.locator('[data-action="prompt-codex-model"]')).toHaveCount(0)
})

test("shows an advertised unavailable Codex engine without allowing it to replace OpenCode", async ({ page }) => {
  await setup(page, { codexAvailable: false })
  await page.goto(draftHref(draftA))

  await expect(page.locator('[data-action="prompt-engine"]')).toBeVisible()
  await choose(page, "prompt-engine", "Codex")
  await expect(page.locator('[data-action="prompt-engine"]')).toContainText("OpenCode")
  await expect(page.getByText("Codex is unavailable", { exact: true })).toBeVisible()
})

test("routes the legacy composer through native Codex create without clearing a rejected input", async ({ page }) => {
  const backend = await setup(page, { newLayout: false })
  await page.goto(`/${base64Encode(directory)}/session`)
  await expect(page.locator('[data-component="prompt-input-v2"]')).toHaveCount(0)
  await expect(page.locator('[data-component="prompt-engine-label"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-engine"]')).toBeVisible()
  const editor = page.locator('[data-component="prompt-input"]')
  await editor.fill("Legacy native draft")
  await choose(page, "prompt-engine", "Codex")
  await page.getByRole("button", { name: "Send", exact: true }).click()

  await expect(editor).toHaveText("Legacy native draft")
  expect(backend.nativeCreates).toHaveLength(1)
  expect(backend.legacyCreates).toBe(0)
})

for (const scenario of [
  { engine: "codex", newLayout: true, label: "Codex" },
  { engine: "codex", newLayout: false, label: "Codex" },
  { engine: "opencode", newLayout: true, label: "OpenCode" },
  { engine: "opencode", newLayout: false, label: "OpenCode" },
] as const) {
  test(`shows a static ${scenario.label} agent for an existing task in the ${scenario.newLayout ? "new" : "legacy"} layout`, async ({
    page,
  }) => {
    await setup(page, { newLayout: scenario.newLayout, sessionEngine: scenario.engine })
    await page.goto(sessionHref)

    const label = page.locator('[data-component="prompt-engine-label"]')
    await expect(label).toHaveText(scenario.label)
    await expect(label).toHaveAttribute("aria-label", "Execution engine")
    await expect(label).not.toHaveAttribute("role", "button")
    await expect(page.locator('[data-action="prompt-engine"]')).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Execution engine", exact: true })).toHaveCount(0)
    await expect(page.locator('[data-component="prompt-input-v2"]')).toHaveCount(scenario.newLayout ? 1 : 0)
    await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
    await expect(page.locator('[data-component="codex-session-docks"]')).toHaveCount(0)
    await expect(page.locator('[data-component="codex-session-controls"]')).toHaveCount(0)
  })
}

test("disables native submission without adding persistent chrome while the runtime is disconnected", async ({
  page,
}) => {
  await setup(page, { runtimeStatus: "disconnected" })
  await page.goto(sessionHref)
  const editor = page.locator('[data-component="prompt-input"]')
  await editor.fill("Do not submit yet")

  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  await expect(page.getByText("Disconnected", { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-component="codex-session-docks"]')).toHaveCount(0)
})

test("keeps an existing Codex engine immutable and submits the complete desired settings", async ({ page }) => {
  const backend = await setup(page)
  await page.goto(sessionHref)
  await expect(page.locator('[data-action="prompt-engine"]')).toHaveCount(0)
  await expect(page.locator('[data-component="prompt-engine-label"]')).toHaveText("Codex")
  await expect(page.locator('[data-action="prompt-codex-model"]')).toContainText("GPT-6-Astra")

  await choose(page, "prompt-codex-model", "GPT-5.6-Luna")
  await expect(page.locator('[data-action="prompt-codex-effort"]')).toBeDisabled()
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toBeDisabled()
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toBeEnabled()
  await choose(page, "prompt-codex-effort", "high")
  await choose(page, "prompt-codex-permission", "Full access")
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toBeDisabled()
  await expect(page.locator('[data-action="prompt-codex-permission"]')).toBeEnabled()

  expect(backend.settings).toEqual([
    { sessionID, model: "gpt-5.6-luna", effort: "medium", permission: "readOnly" },
    { sessionID, model: "gpt-5.6-luna", effort: "high", permission: "readOnly" },
    { sessionID, model: "gpt-5.6-luna", effort: "high", permission: "full" },
  ])

  const editor = page.locator('[data-component="prompt-input"]')
  await expect(editor).toBeEditable()
  await editor.fill("Continue native task")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(editor).toHaveText("")
  expect(backend.nativeSubmits).toEqual([
    expect.objectContaining({
      sessionID,
      delivery: "steer",
      input: expect.objectContaining({
        prompt: { text: "Continue native task", files: [] },
        settings: { model: "gpt-5.6-luna", effort: "high", permission: "full" },
      }),
    }),
  ])
  expect(backend.legacyPrompts).toBe(0)
})

async function choose(page: Page, action: string, option: string) {
  await page.locator(`[data-action="${action}"]`).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

async function setup(
  page: Page,
  options?: {
    advertiseCodex?: boolean
    codexAvailable?: boolean
    newLayout?: boolean
    runtimeStatus?: "idle" | "disconnected"
    sessionEngine?: "codex" | "opencode"
    acceptCreate?: boolean
  },
) {
  const session = {
    id: sessionID,
    engine: options?.sessionEngine ?? "codex",
    projectID,
    directory,
    title: "Codex composer session",
    time: { created: 1, updated: 1 },
  }
  let current = {
    ...descriptor(),
    engine: options?.sessionEngine ?? ("codex" as const),
    runtimeStatus: options?.runtimeStatus ?? ("idle" as const),
  }
  const nativeCreates: LabCreateInput[] = []
  const nativeSubmits: Record<string, unknown>[] = []
  const settings: Record<string, unknown>[] = []
  let legacyCreates = 0
  let legacyPrompts = 0

  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "codex-composer",
      time: { created: 1, updated: 1 },
      sandboxes: [otherDirectory],
    },
    sessions: [
      session,
      ...(options?.acceptCreate
        ? [
            {
              id: createdSessionID,
              engine: "codex",
              projectID,
              directory,
              title: "Created Codex task",
              time: { created: 2, updated: 2 },
            },
          ]
        : []),
    ],
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: { model: { id: "model", name: "OpenCode Model" } } }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "model" },
    },
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/session", (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    legacyCreates++
    return route.fulfill({ status: 500, json: { message: "Unexpected legacy create" } })
  })
  await page.route("**/api/session/*/input", (route) => {
    legacyPrompts++
    return route.fulfill({ status: 500, json: { message: "Unexpected legacy prompt" } })
  })
  await page.route("**/lab/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== server) return route.fallback()
    if (url.pathname === "/lab/engines")
      return json(route, options?.advertiseCodex === false ? [] : engines(options?.codexAvailable ?? true))
    if (url.pathname === "/lab/sessions/describe") {
      const body = route.request().postDataJSON() as { sessionIDs: string[] }
      return json(
        route,
        body.sessionIDs.flatMap((id) => {
          if (id === sessionID) return [current]
          if (id === createdSessionID && options?.acceptCreate) return [{ ...current, sessionID: createdSessionID }]
          return []
        }),
      )
    }
    if (url.pathname === `/lab/sessions/${sessionID}` && route.request().method() === "GET")
      return json(route, snapshot(current))
    if (url.pathname === `/lab/sessions/${createdSessionID}` && route.request().method() === "GET")
      return json(route, snapshot({ ...current, sessionID: createdSessionID }))
    if (url.pathname === "/lab/sessions" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as LabCreateInput
      nativeCreates.push(body)
      if (options?.acceptCreate) {
        const created = {
          ...current,
          sessionID: createdSessionID,
          settings: body.input.settings,
          pendingSettings: undefined,
        }
        return json(route, {
          descriptor: created,
          delivery: {
            sessionID: createdSessionID,
            requestID: body.requestID,
            state: "accepted",
            delivery: body.delivery,
            input: body.input,
            createdAt: Date.now(),
          },
        })
      }
      return json(route, { message: "Native create rejected", code: "nativeError" }, 409)
    }
    if (url.pathname === `/lab/sessions/${sessionID}/settings` && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>
      settings.push({ sessionID, ...body })
      await new Promise((resolve) => setTimeout(resolve, 250))
      current = { ...current, revision: current.revision + 1, pendingSettings: body }
      return json(route, current)
    }
    if (url.pathname === `/lab/sessions/${sessionID}/input` && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>
      nativeSubmits.push({ sessionID, ...body })
      return json(route, {
        descriptor: current,
        delivery: {
          sessionID,
          requestID: body.requestID,
          state: "accepted",
          delivery: body.delivery,
          input: body.input,
          createdAt: Date.now(),
        },
      })
    }
    return json(route, { message: `Unexpected Lab request: ${url.pathname}`, code: "notFound" }, 404)
  })
  await page.addInitScript(
    ({ directory, otherDirectory, draftA, draftB, server, newLayout }) => {
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", server)
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.29" }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [server],
          projects: {
            local: [
              { worktree: directory, expanded: true },
              { worktree: otherDirectory, expanded: true },
            ],
          },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: newLayout, newInterfaceNoticeDismissed: true }, language: "en" }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([
          { type: "draft", draftID: draftA, server, directory },
          { type: "draft", draftID: draftB, server, directory: otherDirectory },
        ]),
      )
    },
    { directory, otherDirectory, draftA, draftB, server, newLayout: options?.newLayout ?? true },
  )
  return {
    nativeCreates,
    nativeSubmits,
    settings,
    get legacyCreates() {
      return legacyCreates
    },
    get legacyPrompts() {
      return legacyPrompts
    },
  }
}

function engines(available: boolean): LabEnginesOutput {
  return [
    {
      id: "codex",
      available,
      error: available ? undefined : "Codex binary is unavailable",
      version: "test",
      account: { authenticated: true, requiresAuth: false },
      capabilities,
      models: [
        { id: "gpt-6-astra", name: "GPT-6-Astra", default: true, efforts: ["low", "medium", "high"] },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6-Luna",
          default: false,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
      ],
    },
  ]
}

function descriptor(): LabDescribeOutput[number] {
  return {
    sessionID,
    engine: "codex",
    epoch: "composer-e2e",
    revision: 1,
    runtimeStatus: "idle",
    bindingState: "bound",
    capabilities,
    queuePaused: false,
    settings: { model: "gpt-6-astra", effort: "medium", permission: "readOnly" },
  }
}

function snapshot(current: LabDescribeOutput[number]): LabSnapshotOutput {
  return {
    descriptor: current,
    messages: [],
    messageOrder: [],
    partOrder: {},
    interactions: [],
    deliveries: [],
    usage: { status: "unavailable" },
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
    json: body,
  })
}
