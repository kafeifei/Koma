import { expect, test, type Locator } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/TaskWorkspaceRegression"
const projectID = "proj_task_workspace"
const bodyNeedle = "violet comet"
const reclaimedDirectory = "C:/OpenCode/TaskWorkspaceRegression/.worktrees/reclaimed"
const betaBody = `Beta body contains ${bodyNeedle} and persists through archive and restore`
const sessions = [
  { id: "ses-task-a", projectID, directory, title: "Alpha task", time: { created: 1, updated: 1 } },
  { id: "ses-task-b", projectID, directory, title: "Beta task", time: { created: 2, updated: 2 } },
]

test.beforeEach(async ({ page }, info) => {
  const archiveTest = info.title.startsWith("archives")
  const running = archiveTest || info.title.startsWith("shows")
  const attention = info.title.startsWith("shows")
  const sessionDirectory = info.title.startsWith("archives reclaimed") ? reclaimedDirectory : directory
  await page.setViewportSize({ width: 1200, height: 800 })
  await mockOpenCodeServer(page, {
    protocol: archiveTest || info.title.startsWith("removes") || info.title.startsWith("deletes") ? "v1" : "v2",
    eventRetry: 60_000,
    findFiles: () => ["TaskWorkspaceRegression"],
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "task-workspace", time: {}, sandboxes: [] },
    sessions: sessions.map((session) => ({
      ...session,
      directory: session.id === "ses-task-b" ? sessionDirectory : session.directory,
      time: {
        ...session.time,
        ...(info.title.startsWith("archives reclaimed") && session.id === "ses-task-b" ? { archived: 123 } : {}),
      },
    })),
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
  if (info.title.startsWith("disables lifecycle")) {
    await page.route("**/api/session/capabilities", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            archive: false,
            restore: false,
            delete: false,
            managedWorktree: false,
            occupancy: { pty: true, v2: true, externalProcesses: false },
          },
        }),
      }),
    )
  }
  if (info.title.startsWith("uses bundled lifecycle")) {
    await page.route("**/api/session/capabilities", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            archive: true,
            restore: true,
            delete: true,
            managedWorktree: true,
            occupancy: { pty: true, v2: true, externalProcesses: false },
          },
        }),
      }),
    )
  }
  if (info.title.startsWith("retries failed lifecycle capabilities")) {
    let requests = 0
    await page.route("**/api/session/capabilities", (route) => {
      requests += 1
      if (requests === 1) return route.fulfill({ status: 500, json: { message: "capabilities unavailable" } })
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            archive: true,
            restore: true,
            delete: true,
            managedWorktree: true,
            occupancy: { pty: true, v2: true, externalProcesses: false },
          },
        }),
      })
    })
  }
  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      if (!localStorage.getItem("opencode.global.dat:server")) {
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: { local: [{ worktree: directory, expanded: true }] },
            lastProject: { local: directory },
          }),
        )
      }
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

test("removes the current project during search and restores its tasks when added again", async ({ page }) => {
  const mutations: string[] = []
  page.on("request", (request) => {
    if (!["POST", "PATCH", "DELETE"].includes(request.method())) return
    if (/\/(session|worktree)(\/|$)/.test(new URL(request.url()).pathname)) mutations.push(request.url())
  })
  const sidebar = page.locator('[data-component="task-sidebar"]')
  const project = sidebar.locator('[data-slot="workspace-project"]').filter({ hasText: "Beta task" })
  await sidebar.getByRole("searchbox").fill("Beta")
  await expect(project.locator('[data-session-id="ses-task-a"]')).toBeHidden()
  await project.getByRole("button", { name: "Remove project", exact: true }).click()
  await page.getByRole("menuitem", { name: "Remove project", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Alpha task", exact: true })).toBeHidden()
  await expect(sidebar.locator('[data-slot="workspace-project"]')).toHaveCount(0)
  await page.reload()
  await expect(sidebar.locator('button[aria-label="Add project"]')).toBeVisible()
  await expect(sidebar.locator('[data-slot="workspace-project"]')).toHaveCount(0)
  const browsing: string[] = []
  const recordBrowse = (request: import("@playwright/test").Request) => browsing.push(new URL(request.url()).pathname)
  page.on("request", recordBrowse)
  await sidebar.locator('button[aria-label="Add project"]').click()
  const picker = page.getByRole("dialog").getByRole("textbox")
  await picker.fill("TaskWorkspaceRegression")
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /C:\/OpenCode\/.*TaskWorkspaceRegression/ }),
  ).toBeVisible()
  page.off("request", recordBrowse)
  expect(browsing).toContain("/api/directory")
  expect(browsing.filter((path) => ["/file", "/api/file", "/find/file", "/api/find/file"].includes(path))).toEqual([])
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /C:\/OpenCode\/.*TaskWorkspaceRegression/ })
    .click()
  await expect(sidebar.locator('[data-session-id="ses-task-a"]')).toBeVisible()
  await expect(sidebar.locator('[data-session-id="ses-task-b"]')).toBeVisible()
  expect(mutations).toEqual([])
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
  await expect(page.getByRole("menuitem")).toHaveText(["Pin", "Rename", "Archive", "Delete"])
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
  await expect(page.getByRole("menuitem")).toHaveText(["Unpin", "Rename", "Archive", "Delete"])
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

test("archives and cancels and retries deleting a task without losing the dialog", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  const requests: string[] = []
  await page.route("**/session/ses-task-b**", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback()
    requests.push("delete")
    if (requests.length === 1)
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Delete rejected" }),
      })
    return route.fulfill({ status: 204 })
  })
  await taskRow(sidebar, "ses-task-b").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(requests).toEqual([])

  await taskRow(sidebar, "ses-task-b").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("Delete rejected")
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(sidebar.locator('[data-session-id="ses-task-b"]')).toBeHidden()
  expect(requests).toEqual(["delete", "delete"])
  await expect(page.getByRole("heading", { name: "Alpha task", exact: true })).toBeVisible()
})

test("deletes the active task and keeps the workbench usable", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await sidebar.locator('[data-session-id="ses-task-b"]').click()
  await expect(page.getByRole("heading", { name: "Beta task", exact: true })).toBeVisible()
  await taskRow(sidebar, "ses-task-b").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(sidebar.locator('[data-session-id="ses-task-b"]')).toBeHidden()
  await sidebar.locator('[data-session-id="ses-task-a"]').click()
  await expect(page.getByRole("heading", { name: "Alpha task", exact: true })).toBeVisible()
})

test("archives a task then deletes the last row in its archived project", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await taskRow(sidebar, "ses-task-b").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click()
  await sidebar.locator('[data-action="workspace-archives"]').click()
  await taskRow(sidebar, "ses-task-b").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(sidebar.locator('[data-slot="workspace-project"]')).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Alpha task", exact: true })).toBeVisible()
})

test("archives failed worktree cleanup and retries archive", async ({ page }) => {
  let statusCalls = 0
  const archiveCalls: string[] = []
  await page.route("**/experimental/session/ses-task-b/worktree**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    statusCalls++
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        archiveCalls.length < 2
          ? { managed: true, state: "failed", operation: "archive", message: "cleanup failed" }
          : { managed: false },
      ),
    })
  })
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/session/ses-task-b")) archiveCalls.push("archive")
  })
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await taskRow(sidebar, "ses-task-b").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click()
  await sidebar.locator('[data-action="workspace-archives"]').click()
  const archived = sidebar.locator('[data-session-id="ses-task-b"]')
  await expect(archived).toBeVisible()
  await taskRow(sidebar, "ses-task-b").hover()
  await taskRow(sidebar, "ses-task-b").getByRole("button", { name: "More options", exact: true }).click()
  await expect.poll(() => statusCalls).toBeGreaterThan(0)
  await expect(page.getByRole("menuitem", { name: "Retry Worktree cleanup", exact: true })).toBeVisible()
  await page.getByRole("menuitem", { name: "Retry Worktree cleanup", exact: true }).click()
  await expect.poll(() => archiveCalls.length).toBe(2)
  await expect(page.getByRole("menuitem", { name: "Retry Worktree cleanup", exact: true })).toBeHidden()
})

test("archives reclaimed worktree session under its project and restores with project directory", async ({ page }) => {
  const restoreRequests: string[] = []
  await page.route("**/session/ses-task-b**", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    const url = new URL(route.request().url())
    restoreRequests.push(
      url.searchParams.get("directory") ?? decodeURIComponent(route.request().headers()["x-opencode-directory"] ?? ""),
    )
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...sessions[1],
        directory: reclaimedDirectory,
        time: { ...sessions[1].time, archived: null },
      }),
    })
  })
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await sidebar.locator('[data-action="workspace-archives"]').click()
  const archived = sidebar.locator('[data-session-id="ses-task-b"]')
  await expect(archived).toBeVisible()
  await archived.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click()
  await expect.poll(() => restoreRequests).toEqual([directory])
})

test("archives an idle task, preserves its identity and body, restores it, and blocks a running task", async ({
  page,
}) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  const composer = page.getByRole("textbox", { name: "Prompt" })
  const draft = "Beta draft survives archive and restore"

  await taskRow(sidebar, "ses-task-a").click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeEnabled()
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeDisabled()
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

test("shows the Sandy worktree checkbox and base branch selector", async ({ page }) => {
  await page.route("**/experimental/worktree/options**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          hasHead: true,
          currentBranch: "main",
          defaultBranch: "main",
          branches: ["main", "release"],
        }),
      })
    return route.fallback()
  })
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await sidebar.locator('button[data-action="workspace-new-task"]').click()
  await expect(page).toHaveURL(/\/new-session\?/)
  const editor = page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
  await editor.fill("Keep this input")
  const href = page.url()
  const worktreeControl = page.locator('[data-action="prompt-worktree"]')
  const worktree = page.getByRole("checkbox", { name: "Worktree", exact: true })
  await expect(worktree).toBeVisible()
  await expect(worktree).toBeChecked()
  await expect(page.locator('[data-action="prompt-base-branch"]')).toContainText("main")
  await worktreeControl.click()
  await expect(page).toHaveURL(href)
  await expect(editor).toHaveText("Keep this input")
  await expect(page.locator('[data-action="prompt-base-branch"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-current-branch"]')).toContainText("main")
  await worktreeControl.click()
  await expect(page).toHaveURL(href)
  await expect(editor).toHaveText("Keep this input")
  await page.locator('[data-action="prompt-base-branch"]').click()
  await page.getByRole("menuitem", { name: "release", exact: true }).click()
  await expect(page.locator('[data-action="prompt-base-branch"]')).toContainText("release")
  await expect(page).toHaveURL(href)
  await expect(editor).toHaveText("Keep this input")
  await page.screenshot({ path: "/tmp/worktree-lifecycle-selector.png", animations: "disabled" })
})

test("disables lifecycle mutations when the V2 server reports them unsupported", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await taskRow(sidebar, "ses-task-b").click({ button: "right" })

  await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeDisabled()
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeDisabled()
})

test("uses bundled lifecycle capabilities and sends the V2 archive mutation", async ({ page }) => {
  const request = page.waitForRequest(
    (value) => value.method() === "POST" && new URL(value.url()).pathname === "/api/session/ses-task-b/archive",
  )
  const sidebar = page.locator('[data-component="task-sidebar"]')
  await taskRow(sidebar, "ses-task-b").click({ button: "right" })
  const archive = page.getByRole("menuitem", { name: "Archive", exact: true })
  await expect(archive).toBeEnabled()

  await archive.click()

  expect((await request).method()).toBe("POST")
  await expect(sidebar.locator('[data-session-id="ses-task-b"]')).toBeHidden()
})

test("retries failed lifecycle capabilities when opening the task menu", async ({ page }) => {
  const sidebar = page.locator('[data-component="task-sidebar"]')

  await taskRow(sidebar, "ses-task-b").click({ button: "right" })

  await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeEnabled()
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeEnabled()
})

function taskRow(sidebar: Locator, id: string) {
  return sidebar.locator(`[data-slot="workspace-task-row"]:has([data-session-id="${id}"])`)
}

function taskIDs(sidebar: Locator) {
  return sidebar
    .locator("[data-session-id]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-session-id")))
}
