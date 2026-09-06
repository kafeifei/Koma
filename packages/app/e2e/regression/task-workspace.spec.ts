import { expect, test, type Locator } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/TaskWorkspaceRegression"
const projectID = "proj_task_workspace"
const bodyNeedle = "violet comet"
const betaBody = `Beta body contains ${bodyNeedle} and persists through archive and restore`
const sessions = [
  { id: "ses-task-a", projectID, directory, title: "Alpha task", time: { created: 1, updated: 1 } },
  { id: "ses-task-b", projectID, directory, title: "Beta task", time: { created: 2, updated: 2 } },
]

test.beforeEach(async ({ page }, info) => {
  const archiveTest = info.title.startsWith("archives")
  const running = archiveTest || info.title.startsWith("shows")
  const attention = info.title.startsWith("shows")
  await page.setViewportSize({ width: 1200, height: 800 })
  await mockOpenCodeServer(page, {
    protocol: archiveTest ? "v1" : "v2",
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "task-workspace", time: {}, sandboxes: [] },
    sessions: sessions.map((session) => ({ ...session, time: { ...session.time } })),
    provider: { all: [], connected: [], default: {} },
    pageMessages: (sessionID) => ({
      items:
        sessionID === "ses-task-b"
          ? [
              {
                info: {
                  id: "msg-beta-body",
                  sessionID,
                  role: "user",
                  time: { created: 3 },
                },
                parts: [
                  {
                    id: "prt-beta-body",
                    sessionID,
                    messageID: "msg-beta-body",
                    type: "text",
                    text: betaBody,
                  },
                ],
              },
            ]
          : [],
    }),
    sessionSearch: ({ query, archived }) => ({
      data:
        query.toLowerCase() === bodyNeedle && !archived
          ? [{ sessionID: "ses-task-b", directory, snippet: `...body contains ${bodyNeedle} before the conclusion...` }]
          : sessions
              .filter((session) => session.title.toLowerCase().includes(query.toLowerCase()))
              .map((session) => ({ sessionID: session.id, directory, snippet: session.title })),
    }),
    sessionStatus: running ? { "ses-task-a": { type: "running" } } : {},
    permissions: attention
      ? [
          {
            id: "workspace-permission",
            sessionID: "ses-task-b",
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            always: [],
          },
        ]
      : [],
  })
  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    },
    { directory },
  )
  await page.goto(`/${base64Encode(directory)}/session/ses-task-a`)
  await expect(page.locator('[data-component="task-sidebar"]')).toBeVisible()
  await expect(page.getByRole("heading", { name: "Alpha task", exact: true })).toBeVisible()
})

test("keeps session identity and composer drafts while switching and filtering", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  const composer = page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
  await composer.fill("Alpha draft")
  await expect(sidebar.locator('[data-session-id="ses-task-a"]')).toHaveAttribute("aria-current", "page")
  await sidebar.locator('[data-session-id="ses-task-b"]').click()
  await expect(sidebar.locator('[data-session-id="ses-task-b"]')).toHaveAttribute("aria-current", "page")
  await composer.fill("Beta draft")
  await sidebar.locator('[data-session-id="ses-task-a"]').click()
  await expect(composer).toHaveText("Alpha draft")
  await sidebar.getByRole("searchbox").fill("Beta")
  await expect(sidebar.locator('[data-session-id="ses-task-a"]')).toBeHidden()
  await expect(sidebar.locator('[data-session-id="ses-task-b"]')).toBeVisible()
  await sidebar.getByRole("searchbox").fill("")
  await sidebar.locator('[data-session-id="ses-task-b"]').click()
  await expect(composer).toHaveText("Beta draft")
})

test("finds a task from message body text and shows the matching snippet", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await sidebar.getByRole("searchbox").fill(bodyNeedle)

  await expect(sidebar.locator('[data-session-id="ses-task-a"]')).toBeHidden()
  const beta = sidebar.locator('[data-session-id="ses-task-b"]')
  await expect(beta).toBeVisible()
  await expect(beta.locator('[data-slot="workspace-task-title"]')).toHaveText("Beta task")
  await expect(beta.locator('[data-slot="workspace-task-snippet"]')).toContainText(bodyNeedle)
})

test("shows running and pending input on their respective sessions", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await expect(sidebar.locator('[data-session-id="ses-task-a"]')).toHaveAttribute("data-status", "running")
  await expect(sidebar.locator('[data-session-id="ses-task-b"]')).toHaveAttribute("data-status", "attention")
  await expect(
    sidebar.locator('[data-session-id="ses-task-a"]').getByRole("img", { name: "Running", exact: true }),
  ).toBeVisible()
  await expect(
    sidebar.locator('[data-session-id="ses-task-b"]').getByRole("img", { name: "Needs your input", exact: true }),
  ).toBeVisible()
})

test("toggles sidebar with Mod+B and closes the mobile drawer after navigation", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  const modifier = await page.evaluate(() => (/(Mac|iPod|iPhone|iPad)/.test(navigator.platform) ? "Meta" : "Control"))
  await page.locator('[contenteditable="true"]').fill("Keep this draft")
  await page.keyboard.press(`${modifier}+b`)
  await expect(sidebar).toBeHidden()
  await page.keyboard.press(`${modifier}+b`)
  await expect(sidebar).toBeVisible()
  await expect(page.locator('[contenteditable="true"]')).toHaveText("Keep this draft")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(sidebar).toBeHidden()
  await page.getByRole("banner").getByRole("button", { name: "Toggle sidebar" }).click()
  await expect(sidebar).toBeVisible()
  await sidebar.locator('[data-session-id="ses-task-b"]').click()
  await expect(sidebar).toBeHidden()
  await expect(page.getByRole("heading", { name: "Beta task", exact: true })).toBeVisible()
})

test("toggles performance diagnostics from the DEV button", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Toggle debug tools", exact: true })
  const diagnostics = page.getByRole("complementary", { name: "Development performance diagnostics" })
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await expect(diagnostics).toBeHidden()
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await expect(diagnostics).toBeVisible()
  await toggle.click()
  await expect(diagnostics).toBeHidden()
})

test("pins within a project, persists across refresh, and matches the overflow menu", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await taskRow(sidebar, "ses-task-a").click({ button: "right" })
  await expect(page.getByRole("menuitem")).toHaveText(["Pin", "Rename", "Archive"])
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click()

  await expect.poll(() => taskIDs(sidebar)).toEqual(["ses-task-a", "ses-task-b"])
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("opencode.global.dat:task-workspace")))
    .toContain("ses-task-a")

  await page.reload()
  await expect(sidebar).toBeVisible()
  await expect.poll(() => taskIDs(sidebar)).toEqual(["ses-task-a", "ses-task-b"])

  const alpha = taskRow(sidebar, "ses-task-a")
  await alpha.hover()
  await alpha.getByRole("button", { name: "More options" }).click()
  await expect(page.getByRole("menuitem")).toHaveText(["Unpin", "Rename", "Archive"])
})

test("keeps a failed rename value and succeeds on retry", async ({ page }) => {
  let attempts = 0
  await page.route("**/api/session/ses-task-a/rename", async (route) => {
    attempts++
    if (attempts > 1) return route.fallback()
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "Rename rejected" }),
    })
  })

  const alpha = taskRow(page.locator('[data-component="task-sidebar"]'), "ses-task-a")
  await alpha.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()

  const input = page.getByRole("textbox", { name: "Name" })
  await input.fill("Renamed after retry")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(input).toHaveValue("Renamed after retry")
  await expect(page.getByText(/UnexpectedStatus|Rename rejected|Request failed|500/)).toBeVisible()

  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(alpha.locator('[data-slot="workspace-task-title"]')).toHaveText("Renamed after retry")
  expect(attempts).toBe(2)
})

test("renames the only search result without losing the active task", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await sidebar.getByRole("searchbox").fill("Alpha")
  await expect(sidebar.locator("[data-session-id]")).toHaveCount(1)
  await taskRow(sidebar, "ses-task-a").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  await page.getByRole("textbox", { name: "Name" }).fill("Renamed task")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(sidebar.locator("[data-session-id]")).toHaveCount(0)
  await expect(page).toHaveURL(/\/session\/ses-task-a$/)
  await sidebar.getByRole("searchbox").fill("")
  await expect(taskRow(sidebar, "ses-task-a").locator('[data-slot="workspace-task-title"]')).toHaveText("Renamed task")
  await page.reload()
  await expect(page.getByRole("heading", { name: "Renamed task", exact: true })).toBeVisible()
})

test("archives an idle task, preserves its identity and body, restores it, and blocks a running task", async ({
  page,
}) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  const composer = page.getByRole("textbox", { name: "Prompt" })
  const draft = "Beta draft survives archive and restore"

  await taskRow(sidebar, "ses-task-a").click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeDisabled()
  await page.keyboard.press("Escape")

  await sidebar.locator('[data-session-id="ses-task-b"]').click()
  await composer.fill(draft)
  await sidebar.locator('[data-session-id="ses-task-a"]').click()

  await taskRow(sidebar, "ses-task-b").click({ button: "right" })
  const archive = page.getByRole("menuitem", { name: "Archive", exact: true })
  await expect(archive).toBeEnabled()
  await archive.click()
  await expect(sidebar.locator('[data-session-id="ses-task-b"]')).toBeHidden()

  await sidebar.locator('[data-action="workspace-archives"]').click()
  const archived = sidebar.locator('[data-session-id="ses-task-b"]')
  await expect(archived).toBeVisible()
  await archived.click()
  await expect(page).toHaveURL(/\/session\/ses-task-b$/)
  await expect(page.getByText(betaBody, { exact: true })).toBeVisible()

  await taskRow(sidebar, "ses-task-b").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click()
  await expect(archived).toBeHidden()
  await expect(page.getByText("Request failed", { exact: true })).toBeHidden()

  await sidebar.locator('[data-action="workspace-archives"]').click()
  const restored = sidebar.locator('[data-session-id="ses-task-b"]')
  await expect(restored).toBeVisible()
  await restored.click()
  await expect(page).toHaveURL(/\/session\/ses-task-b$/)
  await expect(page.getByText(betaBody, { exact: true })).toBeVisible()
  await expect(composer).toHaveText(draft)
})

function taskRow(sidebar: Locator, id: string) {
  return sidebar.locator(`[data-slot="workspace-task-row"]:has([data-session-id="${id}"])`)
}

function taskIDs(sidebar: Locator) {
  return sidebar
    .locator("[data-session-id]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-session-id")))
}
