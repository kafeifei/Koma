import { expect, test, type Page } from "@playwright/test"
import { currentSession, mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"

const directory = "C:/Koma/state/projectless"
const editor = (page: Page) => page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
const sidebar = (page: Page) => page.locator('[data-component="task-sidebar"]')
const recent = (page: Page) => sidebar(page).locator('[data-slot="workspace-project"][data-directory="koma:recent"]')

async function setup(page: Page, withProject = false) {
  const project = {
    id: "proj-example",
    worktree: "C:/Code/Example",
    name: "Example",
    vcs: "git",
    time: {},
    sandboxes: [],
  }
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
    return route.fulfill({
      json: {
        directory: selected,
        project: { id: selected === project.worktree ? project.id : "global", directory: selected },
      },
    })
  })
  if (withProject) {
    await page.route("**/api/project", (route) =>
      route.fulfill({ json: [{ id: "global", worktree: "/", time: {}, sandboxes: [] }, project] }),
    )
    await page.route("**/api/project/current**", (route) => {
      const selected = new URL(route.request().url()).searchParams.get("directory") ?? directory
      return route.fulfill({ json: { id: selected === project.worktree ? project.id : "global", directory: selected } })
    })
  }
  await page.route("**/experimental/worktree/options**", (route) => {
    const hasHead = withProject && new URL(route.request().url()).searchParams.get("directory") === project.worktree
    return route.fulfill({
      json: { hasHead, currentBranch: hasHead ? "main" : undefined, branches: hasHead ? ["main", "release"] : [] },
    })
  })
  await page.route("**/lab/desktop/projectless-workspace", (route) => {
    const key = route.request().postDataJSON().key
    return route.fulfill({ json: { directory: key ? `${directory}/${key}` : directory } })
  })
  await page.addInitScript(
    (projects) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      if (!localStorage.getItem("opencode.global.dat:server"))
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({ projects: { local: projects }, lastProject: {} }),
        )
    },
    withProject ? [{ ...project, expanded: true }] : [],
  )
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
  await expect(page.locator('[data-action="prompt-project"]')).toHaveText("No project")
  await expect(page.locator('[data-action="prompt-current-branch"]')).toHaveCount(0)
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

test("clears a selected project, retains the input and creates the task in Recent", async ({ page }) => {
  const sessions = await setup(page, true)
  let createdDirectory: string | undefined
  await page.route("**/api/session", (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    createdDirectory = route.request().postDataJSON().location.directory
    const session = {
      id: "ses-unselected-project",
      directory: createdDirectory!,
      projectID: "global",
      title: "Task without a project",
    }
    sessions.push(session)
    return route.fulfill({ json: { data: currentSession(session, session.directory) } })
  })
  await page.route("**/api/session/*/prompt", (route) => route.fulfill({ status: 204 }))
  await page.goto("/")
  await expect(editor(page)).toBeEditable()
  const project = page.locator('[data-action="prompt-project"]')
  const branch = page.locator('[data-action="prompt-base-branch"]')
  const worktree = page.getByRole("checkbox", { name: "Worktree", exact: true })
  await project.click()
  await page.getByRole("menuitemradio", { name: "Example", exact: true }).click()
  await expect(project.getByText("Example", { exact: true })).toBeVisible()
  await expect(branch).toHaveText("main")
  await expect(editor(page)).toBeInViewport({ ratio: 1 })
  await branch.click()
  await page.getByRole("menuitem", { name: "release", exact: true }).click()
  await expect(branch).toHaveText("release")
  await expect(worktree).toBeEnabled()
  await expect(worktree).toBeChecked()
  await page.locator('[data-action="prompt-worktree"]').click()
  await expect(worktree).not.toBeChecked()
  await editor(page).fill("Keep this while clearing the project")
  await editor(page).evaluate((element) => element.setAttribute("data-retention-probe", "original"))
  const draftURL = page.url()
  await project.click()
  await page.getByRole("menuitemradio", { name: "No project", exact: true }).click()
  await expect(project).toHaveText("No project")
  await expect(page).toHaveURL(draftURL)
  await expect(editor(page)).toBeInViewport({ ratio: 1 })
  await expect(editor(page)).toHaveText("Keep this while clearing the project")
  await expect(editor(page)).toHaveAttribute("data-retention-probe", "original")
  await expect(branch).toHaveCount(0)
  await expect(worktree).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-current-branch"]')).toHaveCount(0)
  await page.reload()
  await expect(project).toHaveText("No project")
  await expect(editor(page)).toHaveText("Keep this while clearing the project")
  await project.click()
  await page.getByRole("menuitemradio", { name: "Example", exact: true }).click()
  await expect(branch).toHaveText("release")
  await expect(worktree).not.toBeChecked()
  await project.click()
  await page.getByRole("menuitemradio", { name: "No project", exact: true }).click()
  await expect(project).toHaveText("No project")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  const sent = page.waitForRequest("**/api/session/ses-unselected-project/prompt")
  await editor(page).press("Enter")
  await sent
  await expect(recent(page).locator('[data-session-id="ses-unselected-project"]')).toBeVisible()
  await expect(sidebar(page).locator('[data-slot="workspace-project"][data-directory="C:/Code/Example"]')).toBeVisible()
  expect(createdDirectory).toMatch(new RegExp(`^${directory}/[a-f0-9-]{36}$`))
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
