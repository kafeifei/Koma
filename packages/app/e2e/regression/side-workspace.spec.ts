import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test"
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
const shellOutput = "alpha-shell-output"
const readOutput = "alpha-read-output"
const childCommand = "printf child-session-marker"
const childOutput = "child-session-output"
const otherOutput = "beta-shell-output"
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

  test("offers files, terminals, and background tasks without a browser panel", async ({ page }) => {
    await page.getByRole("button", { name: "Open panel" }).click()

    const menu = page.getByRole("menu")
    await expect(menu.getByRole("menuitem")).toHaveText(["Terminal", "Open file", "Background tasks"])
    await expect(menu.getByRole("menuitem", { name: /browser/i })).toHaveCount(0)
  })

  test("replaces temporary tool details and keeps a pinned tab without expanding the chat row", async ({ page }) => {
    const shell = timelinePart(page, shellPartID)
    const context = page.locator(`[data-timeline-part-ids*="${readPartID}"]`)
    await shell.locator('[data-slot="collapsible-trigger"]').click()

    const side = workspace(page)
    await expect(side.locator('[data-component="side-panel-content"]')).toHaveAttribute("data-panel-type", "tool")
    await expect(side.locator('[data-component="tool-inspector-panel"]')).toContainText(shellOutput)
    await expect(side.locator('[role="tabpanel"]:visible')).toHaveCount(1)
    await expect(side.getByRole("combobox", { name: "Filter files" })).toBeHidden()
    await expect(shell.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")
    await expect(shell).not.toContainText(shellOutput)
    await page.getByRole("button", { name: "Open panel" }).click()
    await expect(page.getByRole("menuitem")).toHaveText(["Terminal", "Open file", "Background tasks"])
    await page.keyboard.press("Escape")

    await context.locator('[data-slot="collapsible-trigger"]').click()
    await expect(context.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")
    await context.locator('[data-slot="context-tool-group-item"]').filter({ hasText: "read" }).click()
    await expect(side.locator('[data-component="tool-inspector-panel"]')).toContainText(readOutput)
    await expect(side.getByRole("tab", { name: /Shell/ })).toHaveCount(0)
    await side.getByRole("button", { name: "Keep tab open" }).click()

    await shell.locator('[data-slot="collapsible-trigger"]').click()
    await expect(side.locator('[data-component="tool-inspector-panel"]')).toContainText(shellOutput)
    await expect(side.getByRole("tab", { name: /Read/ })).toBeVisible()
    await expect(side.getByRole("tab", { name: /Shell/ })).toBeVisible()
  })

  test("previews a subagent without changing the parent route and reports its live status", async ({ page }) => {
    const parentURL = page.url()
    await timelinePart(page, taskPartID).locator('[data-component="task-tool-card"]').click()

    const panel = page.locator('[data-component="child-session-panel"]')
    await expect(page).toHaveURL(parentURL)
    await expectSessionTitle(page, parentTitle)
    await expect(panel).toContainText(childTitle)
    await expect(panel.locator('[data-slot="inspector-status"]')).toHaveAttribute("data-status", "running")
    await expect(panel.locator('[data-inspector-message-id="msg_child_assistant"]')).toContainText(childCommand)
  })

  test("shows background activity beside the active todo dock", async ({ page }) => {
    const dock = page.locator('[data-component="session-todo-dock"]')
    await expect(dock).toBeVisible()
    await expect(dock).toContainText("Keep the side workspace visible")

    await openPanelItem(page, "Background tasks")
    const background = page.locator('[data-component="background-tasks-panel"]')
    await expect(background).toBeVisible()
    await expect(
      background
        .locator('[data-slot="inspector-tool-row"]')
        .filter({ hasText: "bash" })
        .locator('[data-slot="inspector-status"]'),
    ).toHaveAttribute("data-status", "completed")
    await expect(
      background
        .locator('[data-slot="inspector-child-row"]')
        .filter({ hasText: childTitle })
        .locator('[data-slot="inspector-status"]'),
    ).toHaveAttribute("data-status", "running")
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
    await expect(workspace(page).getByRole("tab", { name: /Beta terminal/ })).toBeVisible()
    await expect(terminal).toBeFocused()
    await expect.poll(() => pty.connections(ptyB).length).toBe(1)
    await page.keyboard.type("beta-input")
    await expect.poll(() => pty.input(ptyB).join("")).toContain("beta-input")

    await openPanelItem(page, "Background tasks")
    await expect(page.locator('[data-component="background-tasks-panel"]')).toBeVisible()
    expect(pty.deletes).toEqual([])

    await workspace(page)
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

test.describe("cold-cache child discovery", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page, true, { parentTask: false })
    await page.goto(sessionHref(parentID))
    await expectSessionTitle(page, parentTitle)
    await page.getByRole("button", { name: "Toggle review" }).click()
  })

  test("finds a child from the session index before its task metadata is loaded", async ({ page }) => {
    await openPanelItem(page, "Background tasks")

    const background = page.locator('[data-component="background-tasks-panel"]')
    await expect(background.locator(`[data-slot="inspector-tool-row"]`)).toHaveCount(2)
    const child = background.locator('[data-slot="inspector-child-row"]').filter({ hasText: childTitle })
    await expect(child).toBeVisible()
    await expect(child.locator('[data-slot="inspector-status"]')).toHaveAttribute("data-status", "running")
  })
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
    await expect(page.getByRole("button", { name: "Open panel" })).toHaveCount(0)
  })
})

async function setup(page: Page, newLayout: boolean, options?: { parentTask?: boolean; protocol?: "v1" | "v2" }) {
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
    events: () => events.splice(0),
    eventRetry: 16,
  })
  await page.addInitScript(
    ({ directory, newLayout, server, sessions }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: newLayout } }))
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
  await page.getByRole("button", { name: "Open panel" }).click()
  await page.getByRole("menuitem", { name, exact: true }).click()
}

function timelinePart(page: Page, partID: string) {
  return page.locator(`[data-component="session-turn"] [data-timeline-part-id="${partID}"]`)
}

function workspace(page: Page) {
  return page.locator('#review-panel[aria-label="Side workspace"]')
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

function messages(sessionID: string, options?: { parentTask?: boolean }) {
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
      ].filter((part): part is ReturnType<typeof tool> => !!part),
    )
  if (sessionID === otherID)
    return conversation(otherID, [tool("prt_other_shell", "bash", { command: "printf beta" }, otherOutput)])
  if (sessionID === childID)
    return conversation(childID, [tool("prt_child_shell", "bash", { command: childCommand }, childOutput)])
  return []
}

function conversation(sessionID: string, parts: ReturnType<typeof tool>[]) {
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
