import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { installSseTransport } from "../utils/sse-transport"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/PromptPermissionRegression"
const projectID = "proj_prompt_permission"
const sessionA = "ses_permission_a"
const sessionB = "ses_permission_b"
const draftA = "draft_permission_a"
const draftB = "draft_permission_b"
const href = (id: string) => `/${base64Encode(directory)}/session/${id}`
const draftHref = (id: string) => `/new-session?draftId=${id}`

for (const newLayout of [true, false]) {
  test(`${newLayout ? "new" : "legacy"} composer keeps permission choice with its session and shortcut`, async ({
    page,
  }) => {
    const backend = await setup(page, { newLayout })
    await page.goto(href(sessionA))
    await expect(page.locator('[data-component="prompt-input-v2"]')).toHaveCount(newLayout ? 1 : 0)
    const control = page.locator('[data-action="prompt-permission"]')
    await expect(control).toBeEnabled()
    await expect(control).toContainText("Default permissions")
    await control.click()
    await page.getByRole("menuitemradio", { name: /^Auto-approve/ }).click()
    await expect(control).toContainText("Auto-approve")
    expect(backend.updates).toEqual([{ sessionID: sessionA, permissionMode: "auto" }])
    await control.click()
    await page.getByRole("menuitemradio", { name: /^Full Access/ }).click()
    await expect(control).toContainText("Full Access")
    await expect(page.getByRole("menu")).toBeHidden()
    await expect(page.locator('[data-component="prompt-input"]')).toBeFocused()

    await page.goto(href(sessionB))
    await expect(control).toBeEnabled()
    await expect(control).toContainText("Default permissions")
    await page.goto(href(sessionA))
    await expect(control).toBeEnabled()
    await expect(control).toContainText("Full Access")
    await control.click()
    await page.getByRole("menuitemradio", { name: /^Auto-approve/ }).click()
    await expect(control).toContainText("Auto-approve")
    await page.locator('[data-component="prompt-input"]').focus()
    await page.keyboard.press("Control+Shift+A")
    await expect(control).toContainText("Default permissions")
    await page.reload()
    await expect(control).toBeEnabled()
    await expect(control).toContainText("Default permissions")
  })

  test(`${newLayout ? "new" : "legacy"} composer can enable auto-approval while a permission is pending`, async ({
    page,
  }) => {
    const child = { ...session("ses_permission_child", "Permission child"), parentID: sessionA }
    const pending = [
      {
        id: "permission-a",
        sessionID: child.id,
        permission: "bash",
        patterns: ["git status"],
        always: [],
        metadata: {},
      },
      { id: "permission-b", sessionID: sessionB, permission: "bash", patterns: ["git diff"], always: [], metadata: {} },
    ]
    const transport = await installSseTransport(page, { server: "http://127.0.0.1:4096" })
    const backend = await setup(page, { newLayout, permissions: () => pending, extraSession: child })
    await page.goto(href(sessionA))
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible()
    const control = page.locator('[data-action="prompt-permission"]')
    await expect(control).toBeEnabled()
    await control.click()
    await page.getByRole("menuitemradio", { name: /^Auto-approve/ }).click()
    await expect.poll(() => backend.updates).toEqual([{ sessionID: sessionA, permissionMode: "auto" }])
    expect(backend.replies).toEqual([])
    // The server owns pending requests; a successful mode selection must not make the UI approve them.
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible()
    pending.splice(0, 1)
    await transport.waitForConnection()
    await transport.send({
      directory,
      payload: {
        id: "evt_backend_approved",
        type: "permission.replied",
        properties: {
          sessionID: child.id,
          requestID: "permission-a",
          reply: "once",
        },
      },
    })
    await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
    await expect(control).toContainText("Auto-approve")
    await page.goto(href(sessionB))
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible()
    await expect(control).toContainText("Default permissions")
    expect(backend.replies).toEqual([])
  })
}

test("a rejected mode update preserves the confirmed mode", async ({ page }) => {
  await setup(page, { newLayout: true })
  await page.route("**/session/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, json: { name: "UnknownError", data: { message: "Permission update failed" } } })
      : route.fallback(),
  )
  await page.goto(href(sessionA))
  const control = page.locator('[data-action="prompt-permission"]')
  await expect(control).toBeEnabled()
  await control.click()
  await page.getByRole("menuitemradio", { name: /^Full Access/ }).click()
  await expect(page.getByText("Permission update failed", { exact: false }).first()).toBeVisible()
  await expect(control).toContainText("Default permissions")
  await expect(control).toBeEnabled()
})

test("an older server cannot silently claim Full Access after ignoring the setting", async ({ page }) => {
  const backend = await setup(page, { newLayout: true })
  await page.route("**/session/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ json: { ...backend.sessions[0], permissionMode: undefined } })
      : route.fallback(),
  )
  await page.goto(href(sessionA))
  const control = page.locator('[data-action="prompt-permission"]')
  await expect(control).toBeEnabled()
  await control.click()
  await page.getByRole("menuitemradio", { name: /^Full Access/ }).click()
  await expect(page.getByText("does not support session permission modes", { exact: false }).first()).toBeVisible()
  await expect(control).toContainText("Default permissions")
  expect(backend.replies).toEqual([])
})

test("another client's confirmed mode update is reflected without local execution", async ({ page }) => {
  const transport = await installSseTransport(page, { server: "http://127.0.0.1:4096" })
  const backend = await setup(page, { newLayout: true })
  await page.goto(href(sessionA))
  const control = page.locator('[data-action="prompt-permission"]')
  await expect(control).toBeEnabled()
  await transport.waitForConnection()
  backend.sessions[0]!.permissionMode = "full"
  await transport.send({
    directory,
    payload: {
      id: "evt_remote_mode",
      type: "session.next.permission-mode.changed",
      properties: { sessionID: sessionA, timestamp: Date.now(), permissionMode: "full" },
    },
  })
  await expect(control).toContainText("Full Access")
  expect(backend.updates).toEqual([])
  expect(backend.replies).toEqual([])
})

test("the current protocol persists Full Access through the backend mode endpoint", async ({ page }) => {
  const backend = await setup(page, { newLayout: true, protocol: "v2" })
  await page.goto(`/server/${base64Encode("http://127.0.0.1:4096")}/session/${sessionA}`)
  const control = page.locator('[data-action="prompt-permission"]')
  await expect(control).toBeEnabled()
  await expect(control).toContainText("Default permissions")
  await control.click()
  await page.getByRole("menuitemradio", { name: /^Full Access/ }).click()
  await expect(control).toContainText("Full Access")
  expect(backend.updates).toEqual([{ sessionID: sessionA, permissionMode: "full" }])
  expect(backend.replies).toEqual([])
  await page.reload()
  await expect(control).toContainText("Full Access")
})

test("new draft permission choices stay with the draft and do not change existing sessions", async ({ page }) => {
  await setup(page, { newLayout: true })
  await page.goto(draftHref(draftA))
  const control = page.locator('[data-action="prompt-permission"]')
  await expect(control).toBeEnabled()
  await control.click()
  await page.getByRole("menuitemradio", { name: /^Auto-approve/ }).click()
  await expect(control).toContainText("Auto-approve")

  await page.goto(draftHref(draftB))
  await expect(control).toBeEnabled()
  await expect(control).toContainText("Default permissions")
  await page.goto(href(sessionA))
  await expect(control).toBeEnabled()
  await expect(control).toContainText("Default permissions")
  await page.goto(draftHref(draftA))
  await expect(control).toBeEnabled()
  await expect(control).toContainText("Auto-approve")
})

test("a draft sends Full Access atomically when creating its session", async ({ page }) => {
  const created = session("ses_permission_created", "Created permission session")
  await setup(page, { newLayout: true, extraSession: created })
  const creates: Record<string, unknown>[] = []
  await page.route("**/session?**", (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const body = route.request().postDataJSON()
    creates.push(body)
    created.permissionMode = body.permissionMode
    return route.fulfill({ json: created })
  })
  await page.route("**/session", (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const body = route.request().postDataJSON()
    creates.push(body)
    created.permissionMode = body.permissionMode
    return route.fulfill({ json: created })
  })
  await page.route("**/prompt_async**", (route) => route.fulfill({ status: 204 }))
  await page.goto(draftHref(draftA))
  const control = page.locator('[data-action="prompt-permission"]')
  await expect(control).toBeEnabled()
  await expect(control).toContainText("Default permissions")
  await control.click()
  await page.getByRole("menuitemradio", { name: /^Full Access/ }).click()
  await expect(control).toContainText("Full Access")
  await page.locator('[data-component="prompt-input"]').fill("Test draft permission transfer")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/session/${created.id}$`))
  await expect(control).toBeEnabled()
  await expect(control).toContainText("Full Access")
  expect(creates).toHaveLength(1)
  expect(creates[0]?.permissionMode).toBe("full")
})

test("permission menu and composer fit on a narrow screen", async ({ page }) => {
  await setup(page, { newLayout: true })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(href(sessionA))
  const control = page.locator('[data-action="prompt-permission"]')
  await expect(control).toBeEnabled()
  await control.click()
  await expect(page.getByRole("menuitemradio", { name: /^Default permissions/ })).toBeInViewport()
  await expect(page.getByRole("menuitemradio", { name: /^Auto-approve/ })).toBeInViewport()
  await expect(page.getByRole("menuitemradio", { name: /^Full Access/ })).toBeInViewport()
  await page.keyboard.press("Escape")
  await page.locator('[data-component="prompt-input"]').fill("Keep the send button visible")
  const send = page.getByRole("button", { name: "Send", exact: true })
  await expect(send).toBeInViewport()
  const model = page.locator('[data-action="prompt-model"]')
  await expect(model).toBeInViewport()
  const bounds = await control.boundingBox()
  const sendBounds = await send.boundingBox()
  expect(bounds).not.toBeNull()
  expect(sendBounds).not.toBeNull()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(sendBounds!.x)
  const modelBounds = await model.boundingBox()
  expect(modelBounds).not.toBeNull()
  expect(modelBounds!.x + modelBounds!.width <= bounds!.x || modelBounds!.y + modelBounds!.height <= bounds!.y).toBe(
    true,
  )
})

async function setup(
  page: Page,
  input: {
    newLayout: boolean
    protocol?: "v1" | "v2"
    permissions?: () => unknown[]
    extraSession?: ReturnType<typeof session>
  },
) {
  await page.setViewportSize({ width: 1280, height: 800 })
  if (!input.newLayout) await page.clock.setFixedTime(new Date("2026-09-06T00:00:00Z"))
  const sessions = [
    session(sessionA, "Permission session A"),
    session(sessionB, "Permission session B"),
    ...(input.extraSession ? [input.extraSession] : []),
  ]
  const updates: { sessionID: string; permissionMode: string }[] = []
  const replies: string[] = []
  await mockOpenCodeServer(page, {
    protocol: input.protocol,
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "permission-regression", time: {}, sandboxes: [] },
    sessions,
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "test-model": { id: "test-model", name: "Test Model", limit: { context: 200_000 }, variants: { high: {} } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test-model" },
    },
    pageMessages: () => ({ items: [] }),
    permissions: input.permissions,
  })
  await page.route("**/session/*", async (route) => {
    const match = new URL(route.request().url()).pathname.match(/^\/session\/([^/]+)$/)
    if (!match || route.request().method() !== "PATCH") return route.fallback()
    const target = sessions.find((item) => item.id === match[1])
    if (!target) return route.fulfill({ status: 404, json: {} })
    const body = route.request().postDataJSON()
    target.permissionMode = body.permissionMode
    updates.push({ sessionID: target.id, permissionMode: body.permissionMode })
    return route.fulfill({ json: target })
  })
  await page.route("**/api/session/*/permission-mode", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3]
    const target = sessions.find((item) => item.id === id)
    if (!target) return route.fulfill({ status: 404, json: {} })
    const body = route.request().postDataJSON()
    target.permissionMode = body.permissionMode
    updates.push({ sessionID: target.id, permissionMode: body.permissionMode })
    return route.fulfill({ status: 204 })
  })
  await page.route(/\/(?:permissions\/[^/]+|permission\/[^/]+\/reply)(?:\?|$)/, (route) => {
    replies.push(route.request().url())
    return route.fulfill({ json: true })
  })
  await page.addInitScript(
    ({ newLayout, directory, draftA, draftB }) => {
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", "http://127.0.0.1:4096")
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.29" }))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: ["http://127.0.0.1:4096"] }))
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: newLayout, newInterfaceNoticeDismissed: true } }),
      )
      if (!localStorage.getItem("opencode.window.browser.dat:tabs")) {
        localStorage.setItem(
          "opencode.window.browser.dat:tabs",
          JSON.stringify([
            { type: "draft", draftID: draftA, server: "http://127.0.0.1:4096", directory },
            { type: "draft", draftID: draftB, server: "http://127.0.0.1:4096", directory },
          ]),
        )
      }
    },
    { newLayout: input.newLayout, directory, draftA, draftB },
  )
  return { updates, replies, sessions }
}

function session(id: string, title: string) {
  return {
    id,
    projectID,
    directory,
    title,
    permissionMode: "default" as "default" | "auto" | "full",
    slug: id,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}
