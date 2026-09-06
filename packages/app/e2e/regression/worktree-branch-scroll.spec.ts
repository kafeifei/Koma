import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/WorktreeBranchScroll"
const branches = [
  "main",
  ...Array.from({ length: 80 }, (_, index) => `release/branch-${String(index).padStart(2, "0")}`),
]
const inputHref = `/new-session?draftId=${encodeURIComponent(`input:${base64Encode(JSON.stringify(["local", directory]))}`)}`

test("scrolls a long Worktree base branch menu to both ends with wheel and touchpad deltas", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 })
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: "proj-branch-scroll",
      worktree: directory,
      vcs: "git",
      name: "BranchScroll",
      time: {},
      sandboxes: [],
    },
    sessions: [
      {
        id: "ses-branch-scroll",
        projectID: "proj-branch-scroll",
        directory,
        title: "Branch scroll task",
        time: { created: 1, updated: 1 },
      },
    ],
    provider: { all: [], connected: [], default: {} },
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/experimental/worktree/options**", (route) =>
    route.fulfill({ json: { hasHead: true, currentBranch: "main", defaultBranch: "main", branches } }),
  )
  await page.addInitScript((directory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, directory)
  await page.goto(`/${base64Encode(directory)}/session/ses-branch-scroll`)
  await expect(page.getByRole("heading", { name: "Branch scroll task", exact: true })).toBeVisible()
  await page.locator('[data-action="workspace-new-task"]').click()
  await expect(page).toHaveURL(new URL(inputHref, page.url()).href)

  await page.locator('[data-action="prompt-base-branch"]').click()
  const menu = page.locator('[data-component="menu-v2-content"]')
  await expect(menu).toBeVisible()
  const last = branches[branches.length - 1]!
  await menu.hover()
  await page.mouse.wheel(0, 2400)
  await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(page.getByRole("menuitem", { name: last, exact: true })).toBeInViewport()
  await page.mouse.wheel(0, -2400)
  await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(page.getByRole("menuitem", { name: branches[0], exact: true })).toBeInViewport()

  const metrics = await menu.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  for (let index = 0; index < 12; index++) await page.mouse.wheel(0, 40)
  await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  for (let index = 0; index < 12; index++) await page.mouse.wheel(0, -40)
  await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBe(0)
})
