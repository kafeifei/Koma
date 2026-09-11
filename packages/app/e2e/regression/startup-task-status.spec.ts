import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

test("shows saved tasks before native status recovery without marking unresolved tasks as running", async ({
  page,
}) => {
  const directory = "C:/OpenCode/StartupTaskStatus"
  const sessions = [
    { id: "ses-unresolved", title: "Saved task", archived: undefined },
    { id: "ses-archived-unresolved", title: "Archived saved task", archived: 2 },
    { id: "ses-archived-active", title: "Archived active task", archived: 2 },
  ].map((item) => ({
    id: item.id,
    title: item.title,
    engine: "codex" as const,
    projectID: "startup-status",
    directory,
    time: { created: 1, updated: 1, archived: item.archived },
  }))
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "startup-status", worktree: directory, vcs: "git", time: {}, sandboxes: [] },
    sessions,
    provider: { all: [], connected: [], default: {} },
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((directory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] } }),
    )
  }, directory)
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const archivedSnapshots: string[] = []
  page.on("request", (request) => {
    if (/\/lab\/sessions\/ses-archived-/.test(new URL(request.url()).pathname)) archivedSnapshots.push(request.url())
  })
  await page.route("**/lab/sessions/describe", async (route) => {
    requested.resolve()
    await release.promise
    const input = route.request().postDataJSON() as { sessionIDs: string[] }
    await route.fulfill({
      json: input.sessionIDs.map((sessionID) => ({
        sessionID,
        engine: "codex",
        epoch: "startup",
        revision: 0,
        runtimeStatus: sessionID === "ses-archived-active" ? "active" : "resolving",
        bindingState: "bound",
        capabilities: { prompt: true, steer: true, queue: "host", compact: false, images: true, permissions: true },
        queuePaused: false,
        settings: {},
      })),
    })
  })
  await page.goto("/")
  await requested.promise
  const task = (id: string) => page.locator(`[data-slot="workspace-task"][data-session-id="${id}"]`)
  try {
    await expect(task("ses-unresolved")).toBeVisible()
    await expect(task("ses-unresolved")).not.toHaveAttribute("data-status", "running")
  } finally {
    release.resolve()
  }
  await expect(task("ses-unresolved")).toHaveAttribute("data-status", "loading")
  await expect(task("ses-unresolved").getByRole("img", { name: "Loading", exact: true })).toBeVisible()
  await page.locator('[data-action="workspace-archives"]').click()
  await expect(task("ses-archived-unresolved")).toHaveAttribute("data-status", "loading")
  await expect(task("ses-archived-active")).toHaveAttribute("data-status", "running")
  expect(archivedSnapshots).toEqual([])
})
