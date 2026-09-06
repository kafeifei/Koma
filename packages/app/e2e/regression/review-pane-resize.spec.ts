import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ReviewPaneResize"
const projectID = "proj_review_pane_resize"
const sessionID = "ses_review_pane_resize"
const title = "Review pane resize"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const handleSelector = '[data-component="resize-handle"][data-direction="horizontal"]:not(#review-panel *)'

test.use({ viewport: { width: 1440, height: 900 } })

for (const style of ["unified", "split"] as const) {
  test(`resizes ${style} review down to the left sidebar width and restores it`, async ({ page }, testInfo) => {
    await setup(page, style)
    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    await expectSessionTitle(page, title)
    const review = page.locator("#review-panel")
    const sidebar = page.locator('[data-component="task-sidebar"]')
    await expect(review).toBeVisible()
    await expect(page.getByRole("button", { name: "resize.ts", exact: true })).toBeVisible()
    await expect(page.locator(handleSelector)).toHaveCount(1)

    await dragToWidth(page, review, 248)
    await expect.poll(() => width(review)).toBe(248)
    await expect.poll(() => width(sidebar)).toBe(248)
    await page.screenshot({ path: testInfo.outputPath("minimum-width.png") })
    await dragToWidth(page, review, 80)
    await expect.poll(() => width(review)).toBe(248)

    await dragToWidth(page, review, 360)
    await expect.poll(() => width(review)).toBe(360)
    await page.reload()
    await expectSessionTitle(page, title)
    await expect.poll(() => width(review)).toBe(360)

    await dragToWidth(page, review, 248)
    await expect.poll(() => width(review)).toBe(248)
    await page.setViewportSize({ width: 1200, height: 900 })
    await expect.poll(() => width(review)).toBe(248)
    await dragToWidth(page, review, 340)
    await expect.poll(() => width(review)).toBe(340)
  })
}

async function dragToWidth(page: Page, panel: Locator, target: number) {
  const handle = page.locator(handleSelector)
  await expect(handle).toBeVisible()
  const bounds = await handle.boundingBox()
  if (!bounds) throw new Error("Review resize handle is not measurable")
  const start = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(start, y)
  await page.mouse.down()
  await page.mouse.move(start + (await width(panel)) - target, y, { steps: 8 })
  await page.mouse.up()
}

async function width(locator: Locator) {
  return locator.evaluate((element) => Math.round(element.getBoundingClientRect().width))
}

async function setup(page: Page, style: "unified" | "split") {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await mockOpenCodeServer(page, {
    protocol: "v1",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "review-pane-resize",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    vcsDiff: [
      {
        file: "src/resize.ts",
        additions: 1,
        deletions: 1,
        status: "modified",
        patch:
          "diff --git a/src/resize.ts b/src/resize.ts\n--- a/src/resize.ts\n+++ b/src/resize.ts\n@@ -1 +1 @@\n-export const value = 'before'\n+export const value = 'after'\n",
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, style }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      if (!localStorage.getItem("opencode.global.dat:layout"))
        localStorage.setItem(
          "opencode.global.dat:layout",
          JSON.stringify({
            review: { diffStyle: style, panelOpened: true },
            session: { width: 600 },
          }),
        )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    },
    { directory, style },
  )
}
