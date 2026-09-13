import { expect, test, type Page } from "@playwright/test"
import { currentSession, mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"

const directory = "C:/Koma/state/projectless"
const editor = (page: Page) => page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
const sidebar = (page: Page) => page.locator('[data-component="task-sidebar"]')
const recent = (page: Page) => sidebar(page).locator('[data-slot="workspace-project"][data-directory="koma:recent"]')

async function setup(page: Page) {
  const sessions: Array<{ id: string; directory: string; projectID: string; title: string }> = []
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    sessions,
    project: { id: "global", worktree: "/", time: {}, sandboxes: [] },
    provider: fixture.provider,
    pageMessages: () => ({ items: [] }),
  })
  const catalog: Record<string, unknown> = {
    "/api/provider": [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai", settings: {} }],
    "/api/model": [
      {
        id: "gpt-5",
        modelID: "gpt-5",
        providerID: "openai",
        name: "GPT-5",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        variants: [],
        time: { released: 1 },
        cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
        status: "active",
        enabled: true,
        limit: { context: 128000, output: 8192 },
      },
    ],
    "/api/model/default": { id: "gpt-5", providerID: "openai" },
  }
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    return path in catalog
      ? route.fulfill({ json: { location: { directory }, data: catalog[path] } })
      : route.fallback()
  })
  await page.route("**/api/location**", (route) => {
    const selected = new URL(route.request().url()).searchParams.get("location[directory]") ?? directory
    return route.fulfill({ json: { directory: selected, project: { id: "global", directory: selected } } })
  })
  await page.route("**/experimental/worktree/options**", (route) =>
    route.fulfill({ json: { hasHead: false, branches: [] } }),
  )
  await page.route("**/lab/desktop/projectless-workspace", (route) => {
    const key = route.request().postDataJSON().key
    return route.fulfill({ json: { directory: key ? `${directory}/${key}` : directory } })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    if (!localStorage.getItem("opencode.global.dat:server"))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [] }, lastProject: {} }))
  })
  return sessions
}

test("empty startup opens an editable projectless input and retries first send in the same directory", async ({
  page,
}) => {
  const sessions = await setup(page)
  const attempts: string[] = []
  await page.route("**/api/session", (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const dir = route.request().postDataJSON().location.directory as string
    attempts.push(dir)
    if (attempts.length === 1) return route.fulfill({ status: 500, json: { message: "Synthetic create failure" } })
    const session = {
      id: `ses-projectless-${sessions.length + 1}`,
      directory: dir,
      projectID: "global",
      title: `Recent task ${sessions.length + 1}`,
    }
    sessions.push(session)
    return route.fulfill({ json: { data: currentSession(session, dir) } })
  })
  await page.route("**/api/session/*/prompt", (route) => route.fulfill({ status: 204 }))
  await page.goto("/")
  await expect(page).toHaveURL(/\/new-session\?draftId=composer%3A/)
  await expect(editor(page)).toBeEditable()
  await expect(recent(page)).toHaveCount(0)
  await editor(page).fill("Preserve this first task")
  await sidebar(page).getByRole("button", { name: "Home", exact: true }).click()
  await expect(page).toHaveURL(new URL("/", page.url()).href)
  await sidebar(page).locator('[data-action="workspace-new-task"]').click()
  await expect(page).toHaveURL(/\/new-session\?draftId=composer%3A/)
  await expect(editor(page)).toHaveText("Preserve this first task")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  const failed = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/session"),
  )
  await editor(page).press("Enter")
  await failed
  await expect(editor(page)).toHaveText("Preserve this first task")
  await page.reload()
  await expect(editor(page)).toHaveText("Preserve this first task")
  const firstSent = page.waitForRequest("**/api/session/ses-projectless-1/prompt")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await editor(page).press("Enter")
  await firstSent
  await expect(page.getByRole("heading", { name: "Recent task 1", exact: true })).toBeVisible()
  await expect(recent(page).locator('[data-session-id="ses-projectless-1"]')).toBeVisible()
  expect(attempts[0]).toBe(attempts[1])
  expect(attempts[1]).toMatch(new RegExp(`^${directory}/[a-f0-9-]{36}$`))
  await sidebar(page).locator('[data-action="workspace-new-task"]').click()
  await expect(page).toHaveURL(/\/new-session\?draftId=composer%3A/)
  await expect(editor(page)).toBeEditable()
  await editor(page).fill("Independent second task")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  const secondSent = page.waitForRequest("**/api/session/ses-projectless-2/prompt")
  await editor(page).press("Enter")
  await secondSent
  await expect(recent(page).locator('[data-session-id="ses-projectless-2"]')).toBeVisible()
  expect(attempts[2]).not.toBe(attempts[1])
  await page.reload()
  await expect(recent(page).locator('[data-session-id="ses-projectless-1"]')).toBeVisible()
  await expect(recent(page).locator('[data-session-id="ses-projectless-2"]')).toBeVisible()
  await expect(recent(page).getByRole("button", { name: "Remove project", exact: true })).toHaveCount(0)
})

test("workspace preparation failure has a visible retry instead of an empty right pane", async ({ page }) => {
  await setup(page)
  let fail = true
  await page.route("**/lab/desktop/projectless-workspace", (route) =>
    fail
      ? route.fulfill({ status: 500, json: { message: "Synthetic workspace failure" } })
      : route.fulfill({ json: { directory } }),
  )
  await page.goto("/")
  const retry = page.getByRole("button", { name: "Retry", exact: true })
  await expect(retry).toBeEnabled()
  fail = false
  await retry.click()
  await expect(editor(page)).toBeEditable()
  await expect(retry).toHaveCount(0)
})

test("a retained input with a removed project recovers its text on the projectless page", async ({ page }) => {
  await setup(page)
  await page.goto("/")
  await expect(editor(page)).toBeEditable()
  await editor(page).fill("Keep text while recovering the destination")
  const changed = await page.evaluate(() => {
    let changed = 0
    for (const key of Object.keys(localStorage)) {
      if (!key.endsWith(":tabs")) continue
      const tabs = JSON.parse(localStorage.getItem(key)!)
      if (!Array.isArray(tabs)) continue
      for (const tab of tabs)
        if (tab.type === "draft") {
          changed++
          tab.projectless = false
          tab.directory = "C:/Removed/Project"
        }
      localStorage.setItem(key, JSON.stringify(tabs))
    }
    return changed
  })
  expect(changed).toBe(1)
  await page.reload()
  await expect(editor(page)).toHaveText("Keep text while recovering the destination")
  await expect(page.locator('[data-component="session-new-design"]')).toHaveAttribute("data-directory", directory)
})
