import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Locator, type Page, type Route, type WebSocketRoute } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/SideWorkspace"
const projectID = "proj_side_workspace"
const parentID = "ses_side_parent"
const otherID = "ses_side_other"
const childID = "ses_side_child"
const parentTitle = "Side workspace parent"
const otherTitle = "Separate task"
const childTitle = "Inspect the child task"
const shellPartID = "prt_side_shell"
const readPartID = "prt_side_read"
const taskPartID = "prt_side_task"
const failedTaskPartID = "prt_side_failed_task"
const shellOutput = "alpha-shell-output"
const readOutput = "alpha-read-output"
const childCommand = "printf child-session-marker"
const childOutput = "child-session-output"
const otherOutput = "beta-shell-output"
const failedTaskDescription = "Locate shell sidebar navigation"
const failedTaskError = 'Subagent depth limit reached (1). Increase "subagent_depth" to allow nested subagents.'
const overflowFiles = Array.from(
  { length: 14 },
  (_, index) => `src/overflow-${String(index + 1).padStart(2, "0")}-long-file-name.ts`,
)
const ptyA = "pty_side_a"
const ptyB = "pty_side_b"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const ptyFixtures = new WeakMap<Page, Awaited<ReturnType<typeof installPty>>>()

test.use({ viewport: { width: 1440, height: 900 } })

test.describe("new layout", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setup(page, true, { protocol: "v2" })
    if (testInfo.title.includes("terminal")) ptyFixtures.set(page, await installPty(page))
    await page.goto(sessionHref(parentID))
    await expectSessionTitle(page, parentTitle)
    await page.getByRole("button", { name: "Toggle review" }).click()
    await expect(workspace(page)).toHaveAttribute("aria-hidden", "false")
  })

  test("offers peer workspace tabs without a background panel", async ({ page }) => {
    await sideTabs(page).getByRole("button", { name: "Open panel" }).click()

    const menu = page.getByRole("menu")
    await expect(menu.getByRole("menuitem")).toHaveText(["Terminal", "Open file", "Review"])
    await expect(menu.getByRole("menuitem", { name: "Background tasks" })).toHaveCount(0)
    await expect(menu.getByRole("menuitem", { name: /browser/i })).toHaveCount(0)
  })

  test("closes and reopens Review as a peer workspace tab", async ({ page }) => {
    const side = workspace(page)
    const top = sideTabs(page)
    await openPanelItem(page, "Review")

    const review = top.getByRole("tab", { name: "Review" })
    await expect(review).toHaveAttribute("data-selected", "")
    await expect(side.locator('[data-component="session-review-v2"]')).toBeVisible()
    await expect(side.getByRole("button", { name: "Toggle file tree" })).toBeVisible()
    await closeSideTab(review)
    await expect(review).toHaveCount(0)
    await expect(side).toHaveAttribute("aria-hidden", "false")
    await expect(side.locator('[data-component="session-review-v2"]')).toHaveCount(0)

    await openPanelItem(page, "Review")
    await expect(review).toHaveAttribute("data-selected", "")
    await expect(side.locator('[data-component="session-review-v2"]')).toBeVisible()
  })

  test("resizes and restores the task sidebar beside flat, usable panels", async ({ page }) => {
    const sidebar = page.locator('[data-component="task-sidebar"]')
    const handle = sidebar.locator('[data-component="resize-handle"]')
    const toggle = page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .and(page.locator('[aria-controls="task-sidebar"]'))
    const side = workspace(page)
    // The review panel is nested in two wrappers beside the main session panel.
    const session = side.locator("xpath=../../preceding-sibling::div[1]")
    const frame = session.locator(":scope > div").filter({ has: timelinePart(page, shellPartID) })
    const inspector = side.locator('[data-component="tool-inspector-panel"]')
    const output = inspector.locator('[data-slot="bash-pre"]')
    const header = page.locator('[data-slot="titlebar-v2"]')
    const nav = header.locator('[data-slot="workspace-titlebar-nav"]')
    const heading = header.locator('[data-slot="workspace-titlebar-heading"]')
    const tools = header.locator('[data-slot="workspace-titlebar-tools"]')
    const aligned = async (docked = true, direction = "ltr") => {
      await expect(header).toHaveAttribute("data-segmented", "true")
      await expect(header).toHaveAttribute("data-docked", String(docked))
      await expect(header).toHaveAttribute("data-split", "true")
      await expect(nav).toHaveCSS("border-inline-end-width", docked ? "1px" : "0px")
      await expect(tools).toHaveCSS("border-inline-start-width", "1px")
      await expect
        .poll(
          async () => {
            const [top, navigation, title, actions, right, left] = await Promise.all(
              [header, nav, heading, tools, side, sidebar].map((item) => item.boundingBox()),
            )
            if (!top || !navigation || !title || !actions || !right || (docked && !left)) return Infinity
            return Math.max(
              ...[navigation, title, actions].flatMap((box) => [
                Math.abs(box.y - top.y),
                Math.abs(box.y + box.height - top.y - top.height),
              ]),
              Math.abs(direction === "rtl" ? actions.x + actions.width - right.x - right.width : actions.x - right.x),
              ...(docked && left ? [Math.abs(navigation.x - left.x), Math.abs(navigation.width - left.width)] : []),
            )
          },
          { message: "full-height titlebar dividers align with the visible panel boundaries" },
        )
        .toBeLessThanOrEqual(1)
    }

    await expect(sidebar.locator('[data-slot="workspace-footer"]')).toBeVisible()
    await expect(
      sidebar.locator('[data-slot="workspace-footer"]').getByRole("button", { name: "Add project", exact: true }),
    ).toHaveCount(0)
    await expect(
      sidebar
        .locator('[data-slot="workspace-section-heading"]')
        .getByRole("button", { name: "Add project", exact: true }),
    ).toBeVisible()

    await timelinePart(page, shellPartID).locator('[data-slot="collapsible-trigger"]').click()
    await expect(inspector).toContainText(shellOutput)
    await expect(sidebar).toHaveCSS("width", "248px")
    await aligned()
    await handle.hover()
    const start = (await handle.boundingBox())!
    await page.mouse.down()
    await page.mouse.move(start.x + start.width / 2 + 72, start.y + start.height / 2, { steps: 8 })
    await aligned()
    await page.mouse.up()
    await expect(sidebar).toHaveCSS("width", "320px")
    await aligned()
    await expect(output).toHaveText(`$ printf alpha\n\n${shellOutput}`)
    await expect(output).toBeInViewport({ ratio: 1 })

    for (const panel of [sidebar, frame, side]) {
      await expect(panel).toHaveCSS("border-radius", "0px")
      await expect(panel).toHaveCSS("box-shadow", "none")
    }
    await expect
      .poll(async () => {
        const left = (await sidebar.boundingBox())!
        const chat = (await session.boundingBox())!
        const right = (await side.boundingBox())!
        return Math.max(
          Math.abs(chat.x - left.x - left.width),
          Math.abs(right.x - chat.x - chat.width),
          Math.abs(chat.y - right.y),
          Math.abs(right.x + right.width - 1440),
          Math.abs(chat.y + chat.height - 900),
          Math.abs(right.y + right.height - 900),
        )
      })
      .toBeLessThanOrEqual(1)
    await test.info().attach("desktop-sidebar-320-shell", {
      body: await page.screenshot(),
      contentType: "image/png",
    })

    const divider = session.locator('[data-component="resize-handle"][data-direction="horizontal"]')
    const chatWidth = (await session.boundingBox())!.width
    for (const direction of ["ltr", "rtl"] as const) {
      await page.evaluate((dir) => (document.documentElement.dir = dir), direction)
      await expect(divider).toHaveCSS("direction", direction)
      await divider.hover()
      const edge = (await divider.boundingBox())!
      await page.mouse.down()
      await page.mouse.move(edge.x + edge.width / 2 - 100, edge.y + edge.height / 2, { steps: 8 })
      await aligned(true, direction)
      await page.mouse.up()
      await expect(session).toHaveCSS("width", `${chatWidth - (direction === "ltr" ? 100 : 0)}px`)
      await aligned(true, direction)
      await expect(output).toHaveText(`$ printf alpha\n\n${shellOutput}`)
      await expect(output).toBeInViewport({ ratio: 1 })
      if (direction === "rtl") {
        await expect(side).toHaveCSS("border-right-width", "1px")
        await expect(side).toHaveCSS("border-left-width", "0px")
      }
    }
    await page.evaluate(() => (document.documentElement.dir = "ltr"))

    await sideTabs(page).getByRole("tab", { name: /Shell/ }).click()
    await openPanelItem(page, "Review")
    await expect(side.locator('[data-component="session-review-v2"]')).toBeVisible()
    await sideTabs(page).getByRole("tab", { name: /Shell/ }).click()
    await expect(inspector).toContainText(shellOutput)

    await toggle.click()
    await expect(sidebar).toBeHidden()
    await aligned(false)
    await toggle.click()
    await expect(sidebar).toHaveCSS("width", "320px")
    await aligned()
    await expect(inspector).toContainText(shellOutput)
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem("opencode.window.browser.dat:workspace.sidebar") ?? "{}")),
      )
      .toMatchObject({ opened: true, width: 320 })

    await page.reload()
    await expectSessionTitle(page, parentTitle)
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toHaveCSS("width", "320px")
    await expect(handle).toBeVisible()
  })

  test("bounds task sidebar resizing and keeps narrow drawers free of drag handles and overflow", async ({ page }) => {
    const sidebar = page.locator('[data-component="task-sidebar"]')
    const handle = sidebar.locator('[data-component="resize-handle"]')
    const toggle = page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .and(page.locator('[aria-controls="task-sidebar"]'))
    const side = workspace(page)
    const session = side.locator("xpath=../../preceding-sibling::div[1]")
    const header = page.locator('[data-slot="titlebar-v2"]')

    await expect(sidebar).toHaveCSS("width", "248px")
    await handle.hover()
    const start = (await handle.boundingBox())!
    await page.mouse.down()
    await page.mouse.move(start.x + start.width / 2 - 160, start.y + start.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(sidebar).toHaveCSS("width", "248px")

    await page.setViewportSize({ width: 1000, height: 900 })
    await handle.hover()
    const narrow = (await handle.boundingBox())!
    await page.mouse.down()
    await page.mouse.move(990, narrow.y + narrow.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeGreaterThanOrEqual(248)
    await expect.poll(async () => (await session.boundingBox())?.width).toBeGreaterThanOrEqual(450)
    await expect.poll(async () => (await side.boundingBox())?.width).toBeGreaterThanOrEqual(248)
    await expect(side).toBeInViewport({ ratio: 1 })
    await openPanelItem(page, "Review")
    await expect(side.locator('[data-component="session-review-v2"]')).toBeVisible()

    for (const [width, sessionID, title] of [
      [900, otherID, otherTitle],
      [390, parentID, parentTitle],
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await expect(header).toHaveAttribute("data-segmented", String(width >= 768))
      await expect(header).toHaveAttribute("data-docked", "false")
      await expect(header).toHaveAttribute("data-split", String(width >= 768))
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      await expect(sidebar).toBeHidden()
      await toggle.click()
      await expect(sidebar).toBeVisible()
      await expect(sidebar).toHaveCSS("width", "280px")
      await expect(header).toHaveAttribute("data-docked", "false")
      await expect(handle).toHaveCount(0)
      await expect(sidebar).toBeInViewport({ ratio: 1 })
      await test.info().attach(`sidebar-drawer-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      })
      await sidebar.locator(`[data-session-id="${sessionID}"]`).click()
      await expectSessionTitle(page, title)
      await expect(sidebar).toBeHidden()
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
        .toBe(0)
    }
    await test.info().attach("mobile-session-390", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
  })

  test("keeps one task title menu and the workspace toggle at the window edge", async ({ page }) => {
    const header = page.locator('[data-slot="titlebar-v2"]')
    const heading = header.locator("#opencode-titlebar-session-heading")
    const tools = header.locator('[data-slot="workspace-titlebar-tools"]')
    const toggleHost = tools.locator("#opencode-titlebar-workspace-toggle")
    const toggle = toggleHost.getByRole("button", { name: "Toggle review" })

    await expect(heading.locator("[data-session-title]")).toHaveCount(1)
    await expect(heading.getByRole("heading", { name: parentTitle })).toHaveCount(1)
    await expect(heading.getByRole("button", { name: "More options" })).toBeVisible()
    await expect(page.locator("[data-session-title]")).toHaveCount(1)
    await expect(toggle).toBeVisible()
    await expect
      .poll(async () => {
        const [bar, host] = await Promise.all([header.boundingBox(), toggleHost.boundingBox()])
        if (!bar || !host) return Infinity
        return Math.abs(bar.x + bar.width - host.x - host.width)
      })
      .toBeLessThanOrEqual(1)

    const expanded = (await toggle.boundingBox())!
    await toggle.click()
    await expect(workspace(page)).toHaveCount(0)
    await expect(tools).toHaveCSS("border-bottom-width", "1px")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(await toggle.boundingBox()).toEqual(expanded)

    await toggle.click()
    await expect(workspace(page)).toHaveAttribute("aria-hidden", "false")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
  })

  test("replaces temporary tool details and keeps a pinned tab without expanding the chat row", async ({ page }) => {
    const shell = timelinePart(page, shellPartID)
    const context = page.locator(`[data-timeline-part-ids*="${readPartID}"]`)
    await shell.locator('[data-slot="collapsible-trigger"]').click()

    const side = workspace(page)
    await expect(side.locator('[data-component="side-panel-content"]')).toHaveAttribute("data-panel-type", "tool")
    await expect(side.getByRole("button", { name: "Toggle file tree" })).toHaveCount(0)
    await expect(side.locator('[data-component="tool-inspector-panel"]')).toContainText(shellOutput)
    await expect(side.locator('[role="tabpanel"]:visible')).toHaveCount(1)
    await expect(side.getByRole("combobox", { name: "Filter files" })).toBeHidden()
    await expect(shell.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")
    await expect(shell).not.toContainText(shellOutput)
    await sideTabs(page).getByRole("button", { name: "Open panel" }).click()
    await expect(page.getByRole("menuitem")).toHaveText(["Terminal", "Open file", "Review"])
    await page.keyboard.press("Escape")

    await context.locator('[data-slot="collapsible-trigger"]').click()
    await expect(context.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")
    await context.locator('[data-slot="context-tool-group-item"]').filter({ hasText: "read" }).click()
    await expect(side.locator('[data-component="tool-inspector-panel"]')).toContainText(readOutput)
    await expect(sideTabs(page).getByRole("tab", { name: /Shell/ })).toHaveCount(0)
    await expect(side.getByRole("button", { name: "Keep tab open" })).toHaveCount(0)
    const readTab = sideTabs(page).getByRole("tab", { name: /Read/ })
    await readTab.click()

    await shell.locator('[data-slot="collapsible-trigger"]').click()
    await expect(side.locator('[data-component="tool-inspector-panel"]')).toContainText(shellOutput)
    await expect(readTab).toBeVisible()
    await expect(sideTabs(page).getByRole("tab", { name: /Shell/ })).toBeVisible()
    await closeSideTab(readTab)
    await expect(readTab).toHaveCount(0)
  })

  test("previews a subagent without changing the parent route and reports its live status", async ({ page }) => {
    const navigation: Array<Record<string, unknown>> = []
    page.on("console", (message) => {
      const prefix = "[subagent-navigation] "
      if (message.type() !== "info" || !message.text().startsWith(prefix)) return
      navigation.push(JSON.parse(message.text().slice(prefix.length)))
    })

    const parentURL = page.url()
    await timelinePart(page, taskPartID).locator('[data-component="task-tool-card"]').click()

    const panel = workspace(page).locator('[data-component="child-session-panel"]')
    await expect(page).toHaveURL(parentURL)
    await expectSessionTitle(page, parentTitle)
    await expect(panel).toContainText(childTitle)
    await expect(panel.locator('[data-slot="inspector-status"]')).toHaveAttribute("data-status", "running")
    await expect(panel.locator('[data-inspector-message-id="msg_child_assistant"]')).toContainText(childCommand)
    await expect(workspace(page).getByRole("button", { name: "Toggle file tree" })).toHaveCount(0)
    await expect
      .poll(() =>
        [
          ...new Set(
            navigation
              .filter((entry) => entry.targetSessionID === childID)
              .map((entry) => entry.phase)
              .filter((phase) => ["click", "activate", "mounted", "loaded"].includes(String(phase))),
          ),
        ].sort(),
      )
      .toEqual(["activate", "click", "loaded", "mounted"])
    expect(navigation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "click", targetSessionID: childID, action: "preview" }),
        expect.objectContaining({ phase: "activate", targetSessionID: childID, selected: true, opened: true }),
        expect.objectContaining({ phase: "mounted", targetSessionID: childID }),
        expect.objectContaining({ phase: "loaded", targetSessionID: childID }),
      ]),
    )

    const side = workspace(page)
    const childTab = sideTabs(page).getByRole("tab", { name: childTitle })
    await expect(side.getByRole("button", { name: "Keep tab open" })).toHaveCount(0)
    await timelinePart(page, shellPartID).locator('[data-slot="collapsible-trigger"]').click()
    await expect(childTab).toHaveCount(0)

    await timelinePart(page, taskPartID).locator('[data-component="task-tool-card"]').click()
    await expect(childTab).toBeVisible()
    await childTab.click()
    await timelinePart(page, shellPartID).locator('[data-slot="collapsible-trigger"]').click()
    await expect(childTab).toBeVisible()
    await expect(sideTabs(page).getByRole("tab", { name: /Shell/ })).toBeVisible()
    await closeSideTab(childTab)
    await expect(childTab).toHaveCount(0)
  })

  test("keeps the active todo dock beside the workspace", async ({ page }) => {
    const dock = page.locator('[data-component="session-todo-dock"]')
    await expect(dock).toBeVisible()
    await expect(dock).toContainText("Keep the side workspace visible")

    await openPanelItem(page, "Review")
    await expect(workspace(page).locator('[data-component="session-review-v2"]')).toBeVisible()
    await expect(dock).toBeVisible()
  })

  test("keeps a terminal alive across mixed tabs and closing the side workspace", async ({ page }) => {
    const pty = ptyFixtures.get(page)!
    await openPanelItem(page, "Terminal")

    const terminal = page.locator('[data-component="terminal"]')
    await expect(terminal).toBeVisible()
    await expect.poll(() => pty.connections(ptyA).length).toBe(1)
    await expect(terminal).toHaveAttribute("role", "textbox")
    await expect(terminal).toHaveAttribute("aria-label", "Terminal input")
    await expect(terminal).toBeFocused()
    await page.keyboard.type("alpha-input")
    await page.keyboard.press("Enter")
    await expect.poll(() => pty.input(ptyA).join("")).toContain("alpha-input")
    await expect.poll(() => pty.input(ptyA).join("")).toMatch(/[\r\n]/)
    const persistedCursor = pty.outputBytes(ptyA)

    await openPanelItem(page, "Terminal")
    await expect(sideTabs(page).getByRole("tab", { name: /Beta terminal/ })).toBeVisible()
    await expect(terminal).toBeFocused()
    await expect.poll(() => pty.connections(ptyB).length).toBe(1)
    await page.keyboard.type("beta-input")
    await expect.poll(() => pty.input(ptyB).join("")).toContain("beta-input")

    await timelinePart(page, taskPartID).locator('[data-component="task-tool-card"]').click()
    await expect(workspace(page).locator('[data-component="child-session-panel"]')).toBeVisible()
    await expect(workspace(page).getByRole("button", { name: "Toggle file tree" })).toHaveCount(0)
    expect(pty.deletes).toEqual([])

    await sideTabs(page)
      .getByRole("tab", { name: /Alpha terminal/ })
      .click()
    await expect(terminal).toBeVisible()
    await expect.poll(() => pty.connections(ptyA).length).toBe(2)
    expect(new URL(pty.connections(ptyA)[1]!).searchParams.get("cursor")).toBe(String(persistedCursor))
    expect(new URL(pty.connections(ptyA)[1]!).pathname).toBe(`/api/pty/${ptyA}/connect`)

    await page.getByRole("button", { name: "Toggle review" }).click()
    await expect(workspace(page)).toHaveCount(0)
    expect(pty.deletes).toEqual([])
    await page.getByRole("button", { name: "Toggle review" }).click()
    await expect(terminal).toBeVisible()
    await expect.poll(() => pty.connections(ptyA).length).toBe(3)
    expect(new URL(pty.connections(ptyA)[2]!).searchParams.get("cursor")).toBe(String(persistedCursor))
    expect(pty.creates).toBe(2)
    expect(pty.deletes).toEqual([])
  })

  test("does not carry tool details into another task", async ({ page }) => {
    await timelinePart(page, shellPartID).locator('[data-slot="collapsible-trigger"]').click()
    await expect(page.locator('[data-component="tool-inspector-panel"]')).toContainText(shellOutput)

    await page.locator(`[data-component="task-sidebar"] [data-session-id="${otherID}"]`).click()
    await expectSessionTitle(page, otherTitle)
    await expect(page.getByText(shellOutput, { exact: true })).toHaveCount(0)

    await timelinePart(page, "prt_other_shell").locator('[data-slot="collapsible-trigger"]').click()
    await expect(page.locator('[data-component="tool-inspector-panel"]')).toContainText(otherOutput)
    await expect(page.locator('[data-component="tool-inspector-panel"]')).not.toContainText(shellOutput)
  })
})

test.describe("v1 file preview tabs", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page, true, { protocol: "v1" })
    await page.goto(sessionHref(parentID))
    await expectSessionTitle(page, parentTitle)
    await page.getByRole("button", { name: "Toggle review" }).click()
    await expect(workspace(page)).toHaveAttribute("aria-hidden", "false")
  })

  test("keeps a file preview only after its tab is clicked and closes it with the tab X", async ({
    page,
  }, testInfo) => {
    const side = workspace(page)
    await openPanelItem(page, "Open file")
    await expect(side.locator('[data-component="file-panel-toolbar"]')).toBeHidden()
    const filter = side.getByRole("combobox", { name: "Filter files" })
    await filter.fill("alpha")
    await expect(side.getByRole("option", { name: /alpha\.ts/ })).toBeVisible()
    await filter.press("Enter")

    const alphaTab = sideTabs(page).getByRole("tab", { name: "alpha.ts" })
    await expect(alphaTab).toBeVisible()
    await expect(side.getByText("contents:src/alpha.ts", { exact: true })).toBeVisible()
    await expect(side.locator('[data-component="file-panel-toolbar"]')).toHaveCount(1)
    await expect(side.getByRole("button", { name: "Toggle file tree" })).toBeVisible()
    await expect(side.getByRole("button", { name: "Keep tab open" })).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem("opencode.global.dat:layout") ?? "{}").fileTree?.tab),
      )
      .toBe("changes")

    await openPanelItem(page, "Open file")
    await filter.fill("beta")
    await expect(side.getByRole("option", { name: /beta\.ts/ })).toBeVisible()
    await filter.press("Enter")
    await expect(alphaTab).toHaveCount(0)

    const betaTab = sideTabs(page).getByRole("tab", { name: "beta.ts" })
    await expect(betaTab).toBeVisible()
    await expect(side.getByText("contents:src/beta.ts", { exact: true })).toBeVisible()
    await betaTab.click()
    await timelinePart(page, taskPartID).locator('[data-component="task-tool-card"]').click()
    await expect(betaTab).toBeVisible()
    await expect(sideTabs(page).getByRole("tab", { name: childTitle })).toBeVisible()
    await expect(side.locator('[data-component="file-panel-toolbar"]')).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath("file-and-subagent-tabs.png"), fullPage: true })

    await closeSideTab(betaTab)
    await expect(betaTab).toHaveCount(0)
  })

  test("keeps narrow titlebar tabs operable and exposes hidden tabs from the overflow menu", async ({ page }) => {
    const side = workspace(page)
    const top = sideTabs(page)
    const heading = page.locator('[data-slot="workspace-titlebar-heading"]')
    const toggle = page.locator("#opencode-titlebar-workspace-toggle")
    await openPanelItem(page, "Review")

    for (const path of overflowFiles) {
      await openPanelItem(page, "Open file")
      const filter = side.getByRole("combobox", { name: "Filter files" })
      const name = path.split("/").at(-1)!
      await filter.fill(name)
      await expect(side.getByRole("option", { name: new RegExp(name.replace(".", "\\.")) })).toBeVisible()
      await filter.press("Enter")
      const tab = top.getByRole("tab", { name })
      await expect(tab).toHaveAttribute("data-selected", "")
      await tab.click()
    }

    await expect
      .poll(async () => {
        const [tabs, middle, content, right] = await Promise.all(
          [top, heading, side, toggle].map((item) => item.boundingBox()),
        )
        if (!tabs || !middle || !content || !right) return Infinity
        return Math.max(
          Math.abs(tabs.y - middle.y),
          Math.abs(tabs.height - middle.height),
          Math.abs(tabs.x - content.x),
          Math.abs(right.x + right.width - content.x - content.width),
        )
      })
      .toBeLessThanOrEqual(1)
    await expect(heading.getByRole("button", { name: "Status" })).toBeVisible()

    const visibleTabs = top.getByRole("tab")
    await expect.poll(() => visibleTabs.count()).toBeLessThan(overflowFiles.length + 1)
    const widths = await visibleTabs.evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width))
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(47)

    const narrowName = overflowFiles[0]!.split("/").at(-1)!
    const narrowTab = top.getByRole("tab", { name: narrowName })
    const beforeClick = (await narrowTab.boundingBox())!
    await page.mouse.click(beforeClick.x + 8, beforeClick.y + beforeClick.height / 2)
    await expect(narrowTab).toHaveAttribute("data-selected", "")
    expect(await narrowTab.boundingBox()).toEqual(beforeClick)

    await top.getByRole("tab", { name: "Review" }).click()
    const beforeHover = (await narrowTab.boundingBox())!
    await narrowTab.hover()
    await expect(narrowTab.locator("..").getByRole("button", { name: "Close tab" })).toBeVisible()
    expect(await narrowTab.boundingBox()).toEqual(beforeHover)
    await narrowTab.locator("..").getByRole("button", { name: "Close tab" }).click()
    await expect(narrowTab).toHaveCount(0)

    const hiddenName = overflowFiles[7]!.split("/").at(-1)!
    await top.getByRole("button", { name: "All tabs" }).click()
    await page.getByRole("menuitem", { name: hiddenName }).click()
    const selected = top.getByRole("tab", { name: hiddenName })
    await expect(selected).toHaveAttribute("data-selected", "")
    await expect(side.getByText(`contents:${overflowFiles[7]}`, { exact: true })).toBeVisible()

    const closeFromMenu = overflowFiles[10]!.split("/").at(-1)!
    await top.getByRole("button", { name: "All tabs" }).click()
    const row = page.locator('[data-slot="side-panel-tab-menu-row"]').filter({ hasText: closeFromMenu })
    await row.getByRole("button", { name: "Close tab" }).click()
    await expect(row).toHaveCount(0)
  })
})

test.describe("unresolved failed task", () => {
  for (const protocol of ["v1", "v2"] as const) {
    test(`opens ${protocol} task error details when no child session was created`, async ({ page }) => {
      await setup(page, true, { failedTask: true, protocol })
      await page.goto(sessionHref(parentID))
      await expectSessionTitle(page, parentTitle)

      const parentURL = page.url()
      const task = timelinePart(page, failedTaskPartID)
      await expect(task).toContainText(failedTaskDescription)
      await task.locator('[data-slot="collapsible-trigger"]').click()

      await expect(page).toHaveURL(parentURL)
      await expectSessionTitle(page, parentTitle)
      const inspector = page.locator('[data-component="tool-inspector-panel"]')
      await expect(inspector).toBeVisible()
      await expect(inspector).toContainText(failedTaskError)
      await expect(page.locator('[data-component="child-session-panel"]')).toHaveCount(0)
    })
  }
})

test.describe("v1 subagent first-click stability", () => {
  const cases = [
    {
      name: "from a cold parent with the side workspace closed",
      prepare: async (page: Page) => {
        await expect(workspace(page)).toHaveCount(0)
      },
    },
    {
      name: "after switching away from and back to the parent",
      prepare: async (page: Page) => {
        const sidebar = page.locator('[data-component="task-sidebar"]')
        await sidebar.locator(`[data-session-id="${otherID}"]`).click()
        await expectSessionTitle(page, otherTitle)
        await sidebar.locator(`[data-session-id="${parentID}"]`).click()
        await expectSessionTitle(page, parentTitle)
      },
    },
    {
      name: "while replacing a different temporary tool tab",
      prepare: async (page: Page) => {
        await timelinePart(page, shellPartID).locator('[data-slot="collapsible-trigger"]').click()
        await expect(page.locator('[data-component="tool-inspector-panel"]')).toContainText(shellOutput)
        await expect(sideTabs(page).getByRole("tab", { name: /Shell/ })).toBeVisible()
      },
    },
  ]

  for (const entry of cases) {
    test(entry.name, async ({ page }) => {
      await setup(page, true, { protocol: "v1" })
      await page.goto(sessionHref(parentID))
      await expectSessionTitle(page, parentTitle)
      await entry.prepare(page)

      const parentURL = page.url()
      await timelinePart(page, taskPartID).locator('[data-component="task-tool-card"]').click()

      await expect(page).toHaveURL(parentURL)
      await expectSessionTitle(page, parentTitle)
      const panel = page.locator('[data-component="child-session-panel"]')
      await expect(panel).toBeVisible()
      await expect(panel).toContainText(childTitle)
      await expect(workspace(page)).toBeVisible()
      await expect(workspace(page)).toHaveAttribute("aria-hidden", "false")
    })
  }
})

test.describe("legacy layout", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page, false)
    await page.goto(`/${base64Encode(directory)}/session/${parentID}`)
    await expectSessionTitle(page, parentTitle)
  })

  test("keeps tool details inline", async ({ page }) => {
    const shell = timelinePart(page, shellPartID)
    const trigger = shell.locator('[data-slot="collapsible-trigger"]')
    await trigger.click()

    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    await expect(shell).toContainText(shellOutput)
    await expect(workspace(page)).toHaveCount(0)
    await expect(sideTabs(page).getByRole("button", { name: "Open panel" })).toHaveCount(0)
  })
})

async function setup(
  page: Page,
  newLayout: boolean,
  options?: { parentTask?: boolean; failedTask?: boolean; protocol?: "v1" | "v2" },
) {
  const todos = [
    { id: "todo-side", content: "Keep the side workspace visible", status: "in_progress", priority: "high" },
  ]
  const events = newLayout
    ? [{ directory, payload: { type: "todo.updated", properties: { sessionID: parentID, todos } } }]
    : []
  await mockOpenCodeServer(page, {
    protocol: options?.protocol ?? (newLayout ? "v2" : "v1"),
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "side-workspace",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      session(parentID, parentTitle, 1700000000000),
      session(otherID, otherTitle, 1700000001000),
      session(childID, childTitle, 1700000002000, { parentID }),
    ],
    pageMessages: (sessionID) => ({ items: messages(sessionID, options) }),
    sessionStatus: { [parentID]: { type: "busy" }, [childID]: { type: "busy" } },
    todos: (sessionID) => (sessionID === parentID ? todos : []),
    fileList: () => [],
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    findFiles: (input) => {
      if (input.query === "alpha") return ["src/alpha.ts"]
      if (input.query === "beta") return ["src/beta.ts"]
      return overflowFiles.filter((path) => path.endsWith(input.query))
    },
    events: () => events.splice(0),
    eventRetry: 16,
  })
  await page.addInitScript(
    ({ directory, newLayout, server, sessions }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: newLayout, showStatus: true } }),
      )
      if (!newLayout) localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(sessions.map((sessionId: string) => ({ type: "session", server, sessionId }))),
      )
    },
    { directory, newLayout, server, sessions: [parentID, otherID] },
  )
}

async function installPty(page: Page) {
  const deletes: string[] = []
  const connections = new Map<string, string[]>()
  const input = new Map<string, string[]>()
  let creates = 0
  const outputBytes = new Map<string, number>()
  const handlePty = (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const v2 = path.startsWith("/api/")
    if (request.method() === "DELETE") {
      deletes.push(path)
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (request.method() === "POST" && (path === "/api/pty" || path === "/pty")) creates++
    if (path.endsWith("/connect-token"))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(
          v2
            ? { location: ptyLocation(), data: { ticket: "e2e-ticket", expires_in: 60 } }
            : { ticket: "e2e-ticket", expires_in: 60 },
        ),
      })
    if (path.endsWith("/shells"))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(v2 ? { location: ptyLocation(), data: [] } : []),
      })
    const id = (path === "/api/pty" || path === "/pty") && creates > 1 ? ptyB : path.includes(ptyB) ? ptyB : ptyA
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(v2 ? { location: ptyLocation(), data: ptyInfo(id) } : ptyInfo(id)),
    })
  }
  await page.route("**/api/pty**", handlePty)
  await page.route("**/pty**", handlePty)
  const handleSocket = (socket: WebSocketRoute) => {
    const id = new URL(socket.url()).pathname.split("/").at(-2) ?? ""
    const seen = connections.get(id) ?? []
    const first = seen.length === 0
    connections.set(id, [...seen, socket.url()])
    if (first) {
      const prompt = "SIDE-WORKSPACE> "
      outputBytes.set(id, prompt.length)
      socket.send(prompt)
    }
    socket.onMessage((message) => {
      const data = typeof message === "string" ? message : new TextDecoder().decode(message)
      input.set(id, [...(input.get(id) ?? []), data])
      outputBytes.set(id, (outputBytes.get(id) ?? 0) + data.length)
      socket.send(data)
    })
  }
  await page.routeWebSocket(new RegExp(`/api/pty/${ptyA}/connect`), handleSocket)
  await page.routeWebSocket(new RegExp(`/api/pty/${ptyB}/connect`), handleSocket)
  return {
    deletes,
    connections: (id: string) => connections.get(id) ?? [],
    input: (id: string) => input.get(id) ?? [],
    get creates() {
      return creates
    },
    outputBytes: (id: string) => outputBytes.get(id) ?? 0,
  }
}

async function openPanelItem(page: Page, name: string) {
  await sideTabs(page).getByRole("button", { name: "Open panel" }).click()
  await page.getByRole("menuitem", { name, exact: true }).click()
}

function timelinePart(page: Page, partID: string) {
  return page.locator(`[data-component="session-turn"] [data-timeline-part-id="${partID}"]`)
}

function workspace(page: Page) {
  return page.locator('#side-workspace-panel[aria-label="Side workspace"]')
}

function sideTabs(page: Page) {
  return page.locator("#opencode-titlebar-side-panel")
}

async function closeSideTab(tab: Locator) {
  await tab.hover()
  await tab.locator("..").getByRole("button", { name: "Close tab" }).click()
}

function session(id: string, title: string, created: number, extra?: Record<string, unknown>) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
    ...extra,
  }
}

function messages(sessionID: string, options?: { parentTask?: boolean; failedTask?: boolean }) {
  if (sessionID === parentID)
    return conversation(
      parentID,
      [
        tool(shellPartID, "bash", { command: "printf alpha" }, shellOutput),
        tool(readPartID, "read", { filePath: "src/alpha.ts" }, readOutput),
        options?.parentTask === false
          ? undefined
          : tool(
              taskPartID,
              "task",
              { description: childTitle, subagent_type: "explore" },
              "Subagent is still working",
              { sessionId: childID },
            ),
        options?.failedTask ? failedTask() : undefined,
      ].filter((part): part is ToolFixture => !!part),
    )
  if (sessionID === otherID)
    return conversation(otherID, [tool("prt_other_shell", "bash", { command: "printf beta" }, otherOutput)])
  if (sessionID === childID)
    return conversation(childID, [tool("prt_child_shell", "bash", { command: childCommand }, childOutput)])
  return []
}

type ToolFixture = ReturnType<typeof tool> | ReturnType<typeof failedTask>

function conversation(sessionID: string, parts: ToolFixture[]) {
  const userID = `msg_${sessionID}_user`
  const assistantID = sessionID === childID ? "msg_child_assistant" : `msg_${sessionID}_assistant`
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 },
        agent: "build",
        model: { providerID: "opencode", modelID: "test" },
      },
      parts: [{ id: `prt_${sessionID}_user`, sessionID, messageID: userID, type: "text", text: "Inspect activity" }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: userID,
        modelID: "test",
        providerID: "opencode",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: parts.map((part) => ({ ...part, sessionID, messageID: assistantID })),
    },
  ]
}

function tool(id: string, name: string, input: Record<string, unknown>, output: string, metadata = {}) {
  return {
    id,
    type: "tool",
    callID: `call_${id}`,
    tool: name,
    state: {
      status: "completed",
      input,
      output,
      title: name,
      metadata,
      time: { start: 1700000001000, end: 1700000002000 },
    },
  }
}

function failedTask() {
  return {
    id: failedTaskPartID,
    type: "tool",
    callID: `call_${failedTaskPartID}`,
    tool: "task",
    state: {
      status: "error",
      input: { description: failedTaskDescription, subagent_type: "explore" },
      error: failedTaskError,
      title: failedTaskDescription,
      metadata: null,
      time: { start: 1700000001000, end: 1700000002000 },
    },
  }
}

function sessionHref(sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

function ptyLocation() {
  return { directory, project: { id: projectID, directory } }
}

function ptyInfo(id: string) {
  return {
    id,
    title: id === ptyA ? "Alpha terminal" : "Beta terminal",
    command: "cmd.exe",
    args: [],
    cwd: directory,
    status: "running",
    pid: id === ptyA ? 1 : 2,
  }
}
