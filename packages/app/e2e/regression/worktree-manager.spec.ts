import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const root = "C:/OpenCode/WorktreeManager"
const managed = `${root}/.worktrees/kind-wolf`
const orphan = `${root}/.worktrees/old-experiment`

const entry = (input: {
  directory: string
  branch: string
  primary?: boolean
  managed?: boolean
  orphan?: boolean
  canAdopt?: boolean
  sessions?: Array<{ id: string; title: string; archived: boolean; directory: string }>
}) => ({
  directory: input.directory,
  branch: input.branch,
  primary: input.primary ?? false,
  registered: true,
  managed: input.managed ?? false,
  orphan: input.orphan ?? false,
  shared: false,
  missing: false,
  canAdopt: input.canAdopt ?? false,
  sessions: input.sessions ?? [],
  usage: { ownerIDs: [], blocked: false },
})

test("manages worktrees with destructive cancellation and retryable merge failures", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 })
  await mockOpenCodeServer(page, {
    protocol: "v2",
    eventRetry: 60_000,
    directory: root,
    project: { id: "proj-manager", worktree: root, vcs: "git", name: "worktree-manager", time: {}, sandboxes: [] },
    sessions: [
      {
        id: "ses-manager",
        projectID: "proj-manager",
        directory: managed,
        title: "Managed task",
        time: { created: 1, updated: 1 },
      },
    ],
    provider: { all: [], connected: [], default: {} },
    pageMessages: () => ({ items: [] }),
  })

  const entries = [
    entry({ directory: root, branch: "dev", primary: true }),
    entry({
      directory: managed,
      branch: "opencode/kind-wolf",
      managed: true,
      sessions: [{ id: "ses-manager", title: "Managed task", archived: true, directory: managed }],
    }),
    entry({ directory: orphan, branch: "experiment", orphan: true, canAdopt: true }),
  ]
  let managedLoads = 0
  await page.route("**/experimental/worktree/managed**", (route) => {
    managedLoads += 1
    if (managedLoads === 1) return route.fulfill({ status: 503, json: { message: "manager unavailable" } })
    return route.fulfill({ json: entries })
  })
  let detailLoads = 0
  await page.route("**/experimental/worktree/details**", (route) => {
    detailLoads += 1
    if (detailLoads === 1) return route.fulfill({ status: 503, json: { message: "details unavailable" } })
    const directory = route.request().postDataJSON().directory as string
    return route.fulfill({
      json: {
        entry: entries.find((item) => item.directory === directory),
        space: { bytes: 297795584, files: 12, directories: 4, symlinks: 0, errors: 0 },
        ignored: {
          mode: "local",
          preserved: [{ path: ".env", type: "file", reason: "local" }],
          skipped: [{ path: "node_modules", type: "directory", reason: "rebuildable" }],
          unsupported: [],
        },
      },
    })
  })

  let deletes = 0
  await page.route("**/experimental/worktree?**", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback()
    deletes += 1
    return route.fulfill({ json: true })
  })
  let restores = 0
  await page.route("**/api/session/ses-manager/restore**", (route) => {
    restores += 1
    if (restores === 1)
      return route.fulfill({ status: 503, json: { name: "UnknownError", data: { message: "restore failed" } } })
    return route.fulfill({ status: 204 })
  })

  const previewResult = {
    directory: managed,
    target: root,
    sourceHead: "1".repeat(40),
    sourceTree: "2".repeat(40),
    targetHead: "3".repeat(40),
    mergedTree: "4".repeat(40),
    conflicts: ["src/input.ts", "src/sidebar.ts"],
    unresolved: [] as string[],
    resolutions: [
      { path: "src/input.ts", choice: "target" },
      { path: "src/sidebar.ts", choice: "source" },
    ],
    reviewID: "review-final",
    files: ["src/input.ts", "src/sidebar.ts"],
    patch: "diff --git a/src/input.ts b/src/input.ts\n+preserveInput()",
    truncated: false,
  }
  let previews = 0
  const previewBodies: Record<string, unknown>[] = []
  await page.route("**/experimental/worktree/merge/preview**", (route) => {
    previews += 1
    previewBodies.push(route.request().postDataJSON())
    if (previews === 1)
      return route.fulfill({ status: 500, json: { name: "UnknownError", data: { message: "preview failed" } } })
    if (previews === 2)
      return route.fulfill({
        json: {
          ...previewResult,
          unresolved: previewResult.conflicts,
          resolutions: [],
          reviewID: "review-unresolved",
          patch: "conflicting preview",
        },
      })
    return route.fulfill({ json: { ...previewResult, reviewID: `review-final-${previews}` } })
  })
  const applyBodies: Record<string, unknown>[] = []
  await page.route("**/experimental/worktree/merge/apply**", (route) => {
    applyBodies.push(route.request().postDataJSON())
    if (applyBodies.length === 1)
      return route.fulfill({ status: 409, json: { name: "UnknownError", data: { message: "target changed" } } })
    return route.fulfill({ json: true })
  })

  await page.addInitScript(
    ({ root }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: root, expanded: true }] }, lastProject: { local: root } }),
      )
    },
    { root },
  )
  await page.goto(`/${base64Encode(root)}/session/ses-manager`)

  const sidebar = page.locator('[data-component="task-sidebar"]')
  await sidebar.locator('[data-action="project-remove"]').click()
  await page.getByRole("menuitem", { name: "Worktree management", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Could not load worktrees.", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(dialog.getByText("Managed task", { exact: true })).toBeVisible()
  await expect(dialog.getByText("Could not load worktrees.", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(dialog.getByText("284.0 MB", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("restore failed")
  await dialog.getByRole("button", { name: "Restore", exact: true }).click()
  await expect.poll(() => restores).toBe(2)

  await dialog.getByRole("button", { name: /old-experiment/ }).click()
  await dialog.getByRole("button", { name: "Delete unbound worktree", exact: true }).click()
  await expect(
    dialog.getByText(
      `This removes ${orphan} and every local file inside it, including ignored files. It does not delete sessions.`,
    ),
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(deletes).toBe(0)

  await dialog.getByRole("button", { name: /kind-wolf/ }).click()
  await dialog.getByRole("button", { name: "Preview merge", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("preview failed")
  await dialog.getByRole("button", { name: "Preview again", exact: true }).click()
  const applyButton = dialog.getByRole("button", { name: "Apply to staging area", exact: true })
  await expect(applyButton).toBeDisabled()
  await dialog.getByLabel("Keep primary directory version", { exact: true }).first().check()
  await expect(applyButton).toBeDisabled()
  await dialog.getByLabel("Use Worktree version", { exact: true }).nth(1).check()
  await dialog.getByRole("button", { name: "Preview selected versions", exact: true }).click()
  await expect(dialog.locator("pre")).toContainText("preserveInput()")
  await expect(applyButton).toBeEnabled()
  await dialog.getByRole("button", { name: "Apply to staging area", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("target changed")
  await expect(dialog.locator("pre")).toContainText("preserveInput()")
  await expect(applyButton).toBeDisabled()
  await dialog.getByRole("button", { name: "Preview selected versions", exact: true }).click()
  await dialog.getByRole("button", { name: "Apply to staging area", exact: true }).click()
  await expect(dialog.getByRole("status")).toContainText("ready for review and commit")

  expect(previews).toBe(4)
  expect(previewBodies).toEqual([
    { directory: managed, resolutions: [] },
    { directory: managed, resolutions: [] },
    { directory: managed, resolutions: previewResult.resolutions },
    { directory: managed, resolutions: previewResult.resolutions },
  ])
  expect(applyBodies).toEqual([
    {
      directory: managed,
      sourceHead: previewResult.sourceHead,
      sourceTree: previewResult.sourceTree,
      targetHead: previewResult.targetHead,
      mergedTree: previewResult.mergedTree,
      resolutions: previewResult.resolutions,
      reviewID: "review-final-3",
    },
    {
      directory: managed,
      sourceHead: previewResult.sourceHead,
      sourceTree: previewResult.sourceTree,
      targetHead: previewResult.targetHead,
      mergedTree: previewResult.mergedTree,
      resolutions: previewResult.resolutions,
      reviewID: "review-final-4",
    },
  ])
})
