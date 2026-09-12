import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "/tmp/koma-layout-fixture"
const projectID = "proj_desktop_layout"
const sessionID = "ses_desktop_layout"
const ptyID = "pty_desktop_layout"
const title = "Desktop layout regression"

test.use({ viewport: { width: 1280, height: 800 } })

test("home, composer and terminal retain usable space across browser engines", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "Layout fixture",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "desktop-layout",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  const location = { directory, project: { id: projectID, directory } }
  const pty = { id: ptyID, title: "Terminal 1", command: "zsh", args: [], cwd: directory, status: "running", pid: 1 }
  await page.route("**/api/pty**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location,
        data: route.request().url().includes("connect-token") ? { ticket: "layout-test", expires_in: 60 } : pty,
      }),
    }),
  )
  await page.routeWebSocket(new RegExp(`/api/pty/${ptyID}/connect`), (socket) => {
    socket.send("KOMA_LAYOUT_TERMINAL_READY\r\n")
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  await page.goto("/")
  await expect(page.getByRole("textbox", { name: "Search sessions" })).toBeVisible()
  const main = page.locator("main").last()
  const home = main.locator(".scroll-view__viewport").first()
  await expect.poll(async () => (await home.boundingBox())?.height ?? 0).toBeGreaterThan(400)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const composer = page.locator('[data-component="prompt-input"]')
  await expect(composer).toBeVisible()
  const composerBox = await composer.boundingBox()
  expect(composerBox!.y).toBeGreaterThan(400)
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(800)

  await page.keyboard.press("Control+Backquote")
  const terminal = page.locator('[data-component="terminal"]')
  await expect(terminal).toBeVisible()
  await expect.poll(async () => (await terminal.boundingBox())?.height ?? 0).toBeGreaterThan(200)
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(async () => (await terminal.boundingBox())?.height ?? 0).toBeGreaterThan(200)
  await expect(composer).toBeInViewport()
})
