import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { installSseTransport } from "../utils/sse-transport"
import { currentSession } from "../utils/mock-server"

const serverA = "http://127.0.0.1:4096"
const serverB = "http://127.0.0.1:4097"
const directoryA = "C:/server-a"
const directoryB = "/home/server-b"
const sessionA = session("ses_server_a", directoryA, "Server A session")
const childSessionA = { ...session("ses_server_a_child", directoryA, "Server A child session"), parentID: sessionA.id }
const sessionB = session("ses_server_b", directoryB, "Server B session")

test("composer permission choice stays with the remote session and follows settings", async ({ page }) => {
  const requests: PermissionRequestTrace[] = []
  await mockServers(page, requests)
  await configureServers(page)

  await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  const control = page.locator('[data-action="prompt-permission"]')
  await expect(control).toBeEnabled()
  await expect(control).toContainText("Default permissions")
  requests.length = 0
  await control.click()
  await page.getByRole("menuitemradio", { name: /^Auto-approve/ }).click()
  await expect(control).toContainText("Auto-approve")
  await expect.poll(() => requests.some((request) => new URL(request.url).origin === serverB)).toBe(true)
  expect(requests.every((request) => new URL(request.url).origin === serverB)).toBe(true)

  await page.goto(`/server/${base64Encode(serverA)}/session/${sessionA.id}`)
  await expect(control).toBeEnabled()
  await expect(control).toContainText("Default permissions")
  await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  await expect(control).toBeEnabled()
  await expect(control).toContainText("Auto-approve")
  await page.keyboard.press("Control+,")
  const setting = page.locator('[data-action="settings-auto-accept-permissions"]')
  await expect(setting.getByRole("switch")).toBeChecked()
  await setting.locator('[data-slot="switch-control"]').click()
  await expect(setting.getByRole("switch")).not.toBeChecked()
  await page.keyboard.press("Escape")
  await expect(control).toContainText("Default permissions")
})

test("session settings use the remote server context", async ({ page }) => {
  const permissionRequests: PermissionRequestTrace[] = []
  await mockServers(page, permissionRequests)
  await configureServers(page)

  await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  await expect(page.getByRole("heading", { name: sessionB.title, exact: true })).toBeVisible()
  await page.keyboard.press("Control+,")

  const dialog = page.locator(".settings-v2-dialog")
  const autoAccept = dialog.locator('[data-action="settings-auto-accept-permissions"]')
  const input = autoAccept.getByRole("switch")
  await expect(autoAccept).toBeVisible()
  await expect(input).toBeEnabled()
  permissionRequests.length = 0
  await autoAccept.locator('[data-slot="switch-control"]').click()
  await expect(input).toBeChecked()
  await expect
    .poll(() =>
      permissionRequests.some((request) => {
        const url = new URL(request.url)
        return url.origin === serverB && request.directory === directoryB
      }),
    )
    .toBe(true)
  expect(permissionRequests.every((request) => new URL(request.url).origin === serverB)).toBe(true)

  await dialog.getByRole("tab", { name: "Models" }).click()
  await expect(dialog.getByRole("switch", { name: "Server B Model" })).toBeEnabled()
  await expect(dialog.getByRole("switch", { name: "Server A Model" })).toHaveCount(0)
})

test("permission events never cause frontend auto-approval for an unfocused session", async ({ page }) => {
  const requests: PermissionRequestTrace[] = []
  const replies: PermissionResponse[] = []
  const transport = await installSseTransport(page, { server: serverA, retry: 20 })
  await mockServers(page, requests, replies)
  await configureServers(page, [
    { type: "session", server: serverA, sessionId: sessionA.id },
    { type: "session", server: serverB, sessionId: sessionB.id },
  ])
  await page.goto(`/server/${base64Encode(serverA)}/session/${sessionA.id}`)
  const control = page.locator('[data-action="prompt-permission"]')
  await expect(control).toBeEnabled()
  await control.click()
  await page.getByRole("menuitemradio", { name: /^Auto-approve/ }).click()
  await expect(control).toContainText("Auto-approve")
  const hrefB = `/server/${base64Encode(serverB)}/session/${sessionB.id}`
  await page.locator(`[data-component="task-sidebar"] a[href="${hrefB}"]`).click()
  await expect(page.getByRole("heading", { name: sessionB.title, exact: true })).toBeVisible()
  await transport.waitForConnection()
  await transport.send({
    directory: directoryA,
    payload: {
      id: "event-permission-background-a",
      type: "permission.asked",
      properties: {
        id: "permission-background-a",
        sessionID: sessionA.id,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      },
    },
  })
  // Synchronize on a subsequent visible server update, so the permission event has been processed.
  await transport.send({
    directory: directoryA,
    payload: {
      id: "event-background-title",
      type: "session.updated",
      properties: {
        info: { ...sessionA, title: "Background permission event processed", permissionMode: "auto" },
      },
    },
  })
  await expect(
    page.locator('[data-component="task-sidebar"]').getByText("Background permission event processed", { exact: true }),
  ).toBeVisible()
  expect(replies).toEqual([])
})

type PermissionRequestTrace = { url: string; directory?: string }

type PermissionResponse = {
  origin: string
  directory?: string
  sessionID: string
  permissionID: string
  body: unknown
}

async function configureServers(page: Page, tabs: { type: "session"; server: string; sessionId: string }[] = []) {
  await page.addInitScript(
    ({ serverA, serverB, directoryA, directoryB, tabs }) => {
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", serverA)
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [serverA, serverB],
          projects: {
            local: [{ worktree: directoryA, expanded: true }],
            [serverA]: [{ worktree: directoryA, expanded: true }],
            [serverB]: [{ worktree: directoryB, expanded: true }],
          },
        }),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { serverA, serverB, directoryA, directoryB, tabs },
  )
}

async function mockServers(
  page: Page,
  permissionRequests: PermissionRequestTrace[],
  permissionResponses: PermissionResponse[] = [],
) {
  const localSessions = [sessionA, childSessionA, sessionB].map((item) => ({ ...item, permissionMode: "default" }))
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== serverA && url.origin !== serverB) return route.fallback()
    const remote = url.origin === serverB
    const directory = remote ? directoryB : directoryA
    const sessions = localSessions.filter((item) => (remote ? item.id === sessionB.id : item.id !== sessionB.id))
    const encodedDirectory = route.request().headers()["x-opencode-directory"]
    const requestDirectory =
      url.searchParams.get("directory") ?? (encodedDirectory ? decodeURIComponent(encodedDirectory) : undefined)
    const response = url.pathname.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/)
    if (route.request().method() === "POST" && response) {
      permissionResponses.push({
        origin: url.origin,
        directory: requestDirectory ?? undefined,
        sessionID: response[1]!,
        permissionID: response[2]!,
        body: route.request().postDataJSON(),
      })
      return json(route, true)
    }
    if (requestDirectory && requestDirectory !== directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/event")
      return sse(route)
    if (url.pathname === "/global/health") return json(route, { healthy: true })
    if (url.pathname === "/api/provider" || url.pathname === "/api/model" || url.pathname === "/api/agent")
      return json(route, { data: [] })
    if (url.pathname === "/api/model/default") return json(route, { data: null })
    if (["/api/command", "/api/reference", "/api/permission/request", "/api/question/request"].includes(url.pathname))
      return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp") return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json(route, { location: { directory }, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/project") {
      return json(route, [
        {
          id: remote ? sessionB.projectID : "project-server-a",
          worktree: directory,
          vcs: "git",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ])
    }
    if (url.pathname === "/api/project/current")
      return json(route, { id: remote ? sessionB.projectID : "project-server-a", directory })
    if (url.pathname === "/api/session") return json(route, { data: sessions.map(currentSession), cursor: {} })
    if (url.pathname === "/session" || url.pathname === "/experimental/session") return json(route, sessions)
    if (url.pathname === "/api/session/active") return json(route, { data: {} })
    const currentSessionInfo = sessions.find((session) => url.pathname === `/api/session/${session.id}`)
    if (currentSessionInfo) return json(route, { data: currentSession(currentSessionInfo) })
    if (sessions.some((session) => url.pathname === `/api/session/${session.id}/message`))
      return json(route, { data: [], cursor: {} })
    const current = sessions.find((session) => url.pathname === `/session/${session.id}`)
    if (current) {
      if (route.request().method() === "PATCH") {
        current.permissionMode = route.request().postDataJSON().permissionMode
        permissionRequests.push({ url: url.toString(), directory: requestDirectory })
      }
      return json(route, current)
    }
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(route, { name: "NotFoundError" }, 404)
    if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json(route, [])
    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(url.pathname)) return json(route, [])
    if (url.pathname === "/permission") {
      permissionRequests.push({ url: url.toString(), directory: requestDirectory })
      return json(route, [])
    }
    if (["/skill", "/command", "/lsp", "/formatter", "/question", "/vcs/diff", "/pty/shells"].includes(url.pathname))
      return json(route, [])
    if (["/global/config", "/config", "/provider/auth", "/mcp"].includes(url.pathname)) return json(route, {})
    if (url.pathname === "/provider") return json(route, provider(remote ? "server-b" : "server-a"))
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/project" || url.pathname === "/project/current") {
      const project = {
        id: remote ? sessionB.projectID : "project-server-a",
        worktree: directory,
        vcs: "git",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      }
      return json(route, url.pathname === "/project" ? [project] : project)
    }
    if (url.pathname === "/path")
      return json(route, {
        state: directory,
        config: directory,
        worktree: directory,
        directory,
        home: directory,
      })
    if (url.pathname === "/api/path")
      return json(route, { state: directory, config: directory, worktree: directory, directory, home: directory })
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    if (url.pathname === "/api/vcs")
      return json(route, { location: { directory }, data: { branch: "main", defaultBranch: "main" } })
    if (url.pathname === "/api/pty/shells") return json(route, { location: { directory }, data: [] })
    return json(route, {})
  })
}

function session(id: string, directory: string, title: string) {
  return {
    id,
    slug: id,
    projectID: `project-${id}`,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

function provider(id: string) {
  const name = id === "server-b" ? "Server B" : "Server A"
  return {
    all: [
      {
        id,
        name: `${name} Provider`,
        models: {
          [id]: {
            id,
            name: `${name} Model`,
            family: id,
            release_date: "2026-01-01",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: [id],
    default: { providerID: id, modelID: id },
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}
