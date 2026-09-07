import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TerminalRecovery"
const projectID = "proj_terminal_recovery"
const sessionID = "ses_terminal_recovery"
const title = "Terminal recovery"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "terminal-recovery",
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
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { directory, server, sessionID },
  )
})

test("does not create a replacement when terminal initialization fails", async ({ page }) => {
  const pty = await installPty(page)
  const modules = { count: 0 }
  await page.route(/ghostty-web.*\.js/, (route) => {
    modules.count += 1
    return route.fulfill({ status: 200, contentType: "application/javascript", body: "const invalid = ;" })
  })

  await openTerminal(page)
  await expect.poll(() => modules.count).toBeGreaterThan(0)
  await page.waitForTimeout(500)

  expect(pty.creates).toBe(1)
  expect(pty.tokens).toEqual([])
  await expect(sideTabs(page).getByRole("tab")).toHaveCount(1)
})

test("does not create a replacement when the connection ticket is rejected", async ({ page }) => {
  const pty = await installPty(page, { ticketStatus: () => 403 })

  await openTerminal(page)
  await expect.poll(() => pty.tokens.length).toBe(1)
  await page.waitForTimeout(500)

  expect(pty.creates).toBe(1)
  await expect(sideTabs(page).getByRole("tab")).toHaveCount(1)
})

test("discards a recovery candidate that returns after the terminal is closed", async ({ page }) => {
  const pty = await installPty(page, {
    holdCreate: 2,
    missing: (id) => id === "pty_recovery_1",
  })
  await page.routeWebSocket(/\/pty\/pty_recovery_1\/connect/, (socket) => {
    setTimeout(() => void socket.close({ code: 1011, reason: "missing" }), 50)
  })

  await openTerminal(page)
  await expect.poll(() => pty.creates).toBe(2)
  await closeTab(sideTabs(page).getByRole("tab").first())
  await expect(sideTabs(page).getByRole("tab")).toHaveCount(0)

  await pty.releaseHeld("pty_recovery_2")
  await expect.poll(() => pty.deletes).toEqual(expect.arrayContaining(["pty_recovery_1", "pty_recovery_2"]))
  await page.waitForTimeout(250)

  expect(pty.creates).toBe(2)
  await expect(sideTabs(page).getByRole("tab")).toHaveCount(0)
})

test("keeps one recovery budget across a missing replacement remount", async ({ page }) => {
  const pty = await installPty(page, {
    maxCreates: 2,
    missing: (id) => id === "pty_recovery_1" || id === "pty_recovery_2",
  })
  const replacementSockets = { count: 0 }
  await page.routeWebSocket(/\/pty\/pty_recovery_1\/connect/, (socket) => {
    setTimeout(() => void socket.close({ code: 1011, reason: "missing" }), 50)
  })
  await page.routeWebSocket(/\/pty\/pty_recovery_2\/connect/, (socket) => {
    replacementSockets.count += 1
    void socket.close({ code: 1011, reason: "missing before open" })
  })

  await openTerminal(page)
  await expect.poll(() => pty.creates).toBe(2)
  await expect.poll(() => replacementSockets.count).toBe(1)
  await expect.poll(() => pty.gets).toEqual(expect.arrayContaining(["pty_recovery_1", "pty_recovery_2"]))
  await page.waitForTimeout(1_250)

  expect(pty.creates).toBe(2)
  expect(pty.unexpectedCreates).toBe(0)
  await expect(sideTabs(page).getByRole("tab")).toHaveCount(1)
  await expect(sideTabs(page).getByRole("tab").first()).toHaveAttribute("data-value", "terminal://pty_recovery_2")
})

async function openTerminal(page: Page) {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await page.getByRole("button", { name: "Toggle review" }).click()
  await sideTabs(page).getByRole("button", { name: "Open panel" }).click()
  await page.getByRole("menuitem", { name: "Terminal", exact: true }).click()
}

function sideTabs(page: Page) {
  return page.locator("#opencode-titlebar-side-panel")
}

async function closeTab(tab: Locator) {
  await tab.hover()
  await tab.locator("..").getByRole("button", { name: "Close tab" }).click()
}

async function installPty(
  page: Page,
  options: {
    holdCreate?: number
    maxCreates?: number
    missing?: (id: string) => boolean
    ticketStatus?: (id: string) => number
  } = {},
) {
  const state = {
    creates: 0,
    unexpectedCreates: 0,
    tokens: [] as string[],
    gets: [] as string[],
    deletes: [] as string[],
    held: undefined as Route | undefined,
  }
  const headers = { "access-control-allow-origin": "*" }

  await page.route("**/pty**", (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === "/pty/shells")
      return route.fulfill({ status: 200, headers, contentType: "application/json", body: "[]" })

    if (path.endsWith("/connect-token")) {
      const id = path.split("/")[2] ?? ""
      state.tokens.push(id)
      const status = options.ticketStatus?.(id) ?? 200
      return route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: status === 200 ? JSON.stringify({ ticket: "e2e-ticket", expires_in: 60 }) : "rejected",
      })
    }

    const id = path.split("/")[2] ?? ""
    if (request.method() === "DELETE") {
      state.deletes.push(id)
      return route.fulfill({ status: 204, headers })
    }
    if (request.method() === "GET" && options.missing?.(id)) {
      state.gets.push(id)
      return route.fulfill({ status: 404, headers, body: "missing" })
    }
    if (path === "/pty" && request.method() === "POST") {
      state.creates += 1
      if (options.maxCreates !== undefined && state.creates > options.maxCreates) {
        state.unexpectedCreates += 1
        return route.fulfill({ status: 503, headers, body: "unexpected create" })
      }
      if (state.creates === options.holdCreate) {
        state.held = route
        return
      }
      return fulfillPty(route, `pty_recovery_${state.creates}`)
    }
    return fulfillPty(route, id)
  })

  return {
    get creates() {
      return state.creates
    },
    get unexpectedCreates() {
      return state.unexpectedCreates
    },
    get tokens() {
      return state.tokens
    },
    get gets() {
      return state.gets
    },
    get deletes() {
      return state.deletes
    },
    async releaseHeld(id: string) {
      if (!state.held) throw new Error("Expected a held PTY create request")
      await fulfillPty(state.held, id)
      state.held = undefined
    },
  }
}

function fulfillPty(route: Route, id: string) {
  return route.fulfill({
    status: 200,
    headers: { "access-control-allow-origin": "*" },
    contentType: "application/json",
    body: JSON.stringify({
      id,
      title: "Terminal 1",
      command: "cmd.exe",
      args: [],
      cwd: directory,
      status: "running",
      pid: 1,
    }),
  })
}
