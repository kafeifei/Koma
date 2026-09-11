import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

test("keeps an archived task stoppable through its update event and restores the same task", async ({ page }) => {
  const directory = "C:/OpenCode/ArchivedTaskControls"
  const session = {
    id: "ses-archived-controls",
    projectID: "archived-controls",
    directory,
    title: "Archived running task",
    time: { created: 1, updated: 1 },
  }
  await mockOpenCodeServer(page, {
    directory,
    project: { id: session.projectID, worktree: directory, vcs: "git", time: {}, sandboxes: [] },
    sessions: [session],
    sessionStatus: { [session.id]: { type: "busy" } },
    provider: { all: [], connected: [], default: {} },
    pageMessages: () => ({ items: [] }),
  })
  let connected = false
  const events: unknown[] = []
  const listeners: ((event: unknown) => void)[] = []
  const publish = (event: unknown) => {
    const listener = listeners.shift()
    if (listener) return listener(event)
    events.push(event)
  }
  const subscribed = Promise.withResolvers<void>()
  await page.route("**/global/event", async (route) => {
    const first = !connected
    connected = true
    if (!first) subscribed.resolve()
    const payload = first
      ? { type: "server.connected", properties: {} }
      : events.length
        ? events.shift()
        : await new Promise<unknown>((resolve) => listeners.push(resolve))
    await route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*" },
      contentType: "text/event-stream",
      body: `retry: 0\ndata: ${JSON.stringify({ directory, payload })}\n\n`,
    })
  })
  await page.addInitScript((directory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] } }),
    )
  }, directory)
  await page.goto(`/${base64Encode(directory)}/session/${session.id}`)
  const input = page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
  await expect(input).toBeEditable()
  await input.fill("Preserve this unsent draft")
  await subscribed.promise
  const archived = { ...session, time: { ...session.time, archived: 2 } }
  publish({ type: "session.updated", properties: { info: archived } })

  const footer = page.locator('[data-component="session-archived"]')
  await expect(footer).toBeVisible()
  await expect(input).toBeHidden()
  const stop = footer.getByRole("button", { name: "Stop", exact: true })
  await expect(stop).toBeVisible()
  let interrupted = 0
  await page.route(`**/session/${session.id}/abort`, async (route) => {
    interrupted++
    await route.fulfill({ json: true })
    publish({ type: "session.status", properties: { sessionID: session.id, status: { type: "idle" } } })
  })
  const stopRequest = page.waitForRequest(`**/session/${session.id}/abort`)
  await stop.click()
  await stopRequest
  await expect(stop).toBeHidden()
  expect(interrupted).toBe(1)
  await page.route(`**/session/${session.id}`, (route) => route.fulfill({ json: session }))
  await footer.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(footer).toBeHidden()
  await expect(input).toHaveText("Preserve this unsent draft")
  await expect(input).toBeEditable()
})
