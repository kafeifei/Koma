import { expect, test, type Page } from "@playwright/test"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { currentSession, mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"

const directory = "C:/OpenCode/InputRetention"
const other = "C:/OpenCode/OtherProject"
const feature = `${directory}/feature`
const editor = (page: Page) => page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
const sidebar = (page: Page) => page.locator('[data-component="task-sidebar"]')
const newTask = (page: Page) => sidebar(page).locator('[data-action="workspace-new-task"]')
const inputHref = (dir: string) =>
  `/new-session?draftId=${encodeURIComponent(`input:${base64Encode(JSON.stringify(["local", dir]))}`)}`
const openProject = async (page: Page, dir: string) => {
  await sidebar(page)
    .locator(`[data-slot="workspace-project"][data-directory="${dir}"]`)
    .getByRole("button", { name: "New task", exact: true })
    .click()
  await expect(page).toHaveURL(new URL(inputHref(dir), page.url()).href)
  await expect(editor(page)).toBeEditable()
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: "proj-retention",
      worktree: directory,
      vcs: "git",
      name: "InputRetention",
      time: {},
      sandboxes: [feature],
    },
    sessions: [
      {
        id: "ses-retained",
        directory,
        projectID: "proj-retention",
        title: "Existing conversation",
        time: { created: 1, updated: 1 },
      },
    ],
    provider: fixture.provider,
    pageMessages: () => ({ items: [] }),
  })
  const catalog: Record<string, unknown> = {
    "/api/provider": [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai", settings: {} }],
    "/api/model": [
      {
        id: "gpt-5",
        modelID: "gpt-5",
        providerID: "openai",
        name: "GPT-5",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        variants: [],
        time: { released: 1 },
        cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
        status: "active",
        enabled: true,
        limit: { context: 128000, output: 8192 },
      },
    ],
    "/api/model/default": { id: "gpt-5", providerID: "openai" },
  }
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (!(path in catalog)) return route.fallback()
    return route.fulfill({ json: { location: { directory }, data: catalog[path] } })
  })
  await page.route("**/experimental/worktree/options**", (route) =>
    route.fulfill({ json: { hasHead: false, branches: [] } }),
  )
  await page.addInitScript(
    ({ directory, other }) => {
      if (sessionStorage.getItem("retention-fixture")) return
      sessionStorage.setItem("retention-fixture", "1")
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [
              { worktree: directory, expanded: true },
              { worktree: other, expanded: true },
            ],
          },
          lastProject: { local: directory },
        }),
      )
    },
    { directory, other },
  )
  await page.goto(`/${base64Encode(directory)}/session/ses-retained`)
  await expect(page.getByRole("heading", { name: "Existing conversation", exact: true })).toBeVisible()
  await expect(editor(page)).toBeEditable()
})

test("first new-task shortcut preserves Chinese composition and retains the committed text", async ({ page }) => {
  const modifier = await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"))
  await page.keyboard.press(`${modifier}+n`)
  await expect(page).toHaveURL(new URL(inputHref(directory), page.url()).href)
  await expect(editor(page)).toBeEditable()
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).toBeEmpty()

  const cdp = await page.context().newCDPSession(page)
  // Use Chromium's composition engine, not fill(), which bypasses the IME preedit range.
  await cdp.send("Input.imeSetComposition", { text: "n", selectionStart: 0, selectionEnd: 1 })
  await expect(editor(page)).toHaveText("n")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("n")
  await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 0, selectionEnd: 2 })
  await expect(editor(page)).toHaveText("ni")
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("ni")
  await cdp.send("Input.insertText", { text: "\u4f60" })
  await expect(editor(page)).toHaveText("\u4f60")
  await expect(editor(page)).toBeFocused()
  await cdp.detach()

  await sidebar(page).locator('[data-session-id="ses-retained"]').click()
  await expect(editor(page)).toBeEmpty()
  await page.keyboard.press(`${modifier}+n`)
  await expect(editor(page)).toHaveText("\u4f60")
  await expect(editor(page)).toBeFocused()
})

test("reuses new input, keeps conversations separate, and restores after refresh and close", async ({ page }, info) => {
  await editor(page).fill("Conversation-only input")
  await newTask(page).click()
  await expect(editor(page)).toBeEmpty()
  const href = page.url()
  await editor(page).fill("Retained new-task input")
  await newTask(page).click()
  await expect(page).toHaveURL(href)
  await expect(editor(page)).toHaveText("Retained new-task input")
  await expect(sidebar(page).locator("[data-draft-id]")).toHaveCount(0)
  await expect(sidebar(page).getByText("Drafts", { exact: true })).toHaveCount(0)
  await sidebar(page).locator('[data-session-id="ses-retained"]').click()
  await expect(editor(page)).toHaveText("Conversation-only input")
  await newTask(page).click()
  await expect(editor(page)).toHaveText("Retained new-task input")
  await page.reload()
  await expect(editor(page)).toHaveText("Retained new-task input")
  const modifier = await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"))
  await page.keyboard.press(`${modifier}+w`)
  await expect(page).not.toHaveURL(href)
  await openProject(page, directory)
  await expect(editor(page)).toHaveText("Retained new-task input")
  await page.screenshot({ path: info.outputPath("input-retention-desktop.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(editor(page)).toHaveText("Retained new-task input")
  await page.screenshot({ path: info.outputPath("input-retention-mobile.png") })
})

test("retains the last selected permission through close, refresh and first submission", async ({ page }) => {
  await openProject(page, directory)
  const permission = page.locator('[data-action="prompt-permission"]')
  await permission.click()
  await page.getByRole("menuitemradio", { name: /Full Access/ }).click()
  await expect(permission).toContainText("Full Access")
  const href = page.url()
  const modifier = await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"))
  await page.keyboard.press(`${modifier}+w`)
  await expect(page).not.toHaveURL(href)
  await openProject(page, directory)
  await expect(permission).toContainText("Full Access")
  await page.reload()
  await expect(permission).toContainText("Full Access")
  await openProject(page, other)
  await expect(permission).toContainText("Default permissions")
  await openProject(page, directory)
  await editor(page).fill("Keep my permission choice")
  const created = currentSession(
    { id: "ses-permission", title: "Permission task", directory, permissionMode: "full" },
    directory,
  )
  await page.route("**/api/session", (route) =>
    route.request().method() === "POST" ? route.fulfill({ json: { data: created } }) : route.fallback(),
  )
  await page.route("**/api/session/ses-permission", (route) => route.fulfill({ json: { data: created } }))
  await page.route("**/api/session/ses-permission/prompt", (route) => route.fulfill({ status: 204 }))
  const sent = page.waitForRequest("**/api/session/ses-permission/prompt")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await editor(page).press("Enter")
  await sent
  await expect(page.getByRole("heading", { name: "Permission task", exact: true })).toBeVisible()
  await openProject(page, directory)
  await expect(editor(page)).toBeEmpty()
  await expect(permission).toContainText("Full Access")
  await sidebar(page).locator('[data-session-id="ses-retained"]').click()
  await expect(permission).toContainText("Default permissions")
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tabs = JSON.parse(localStorage.getItem("opencode.window.browser.dat:tabs") ?? "[]") as {
          type: string
          draftID?: string
        }[]
        return tabs.filter((tab) => tab.type === "draft").map((tab) => tab.draftID)
      }),
    )
    .toHaveLength(2)
})

test("an explicitly selected default never falls back to the directory's full permission mode on reopen", async ({
  page,
}) => {
  await page.evaluate(
    (key) => {
      localStorage.setItem("opencode.global.dat:permission", JSON.stringify({ directoryMode: { [key]: "full" } }))
    },
    `${base64Encode(directory)}/*`,
  )
  await page.reload()
  await openProject(page, directory)
  const permission = page.locator('[data-action="prompt-permission"]')
  await expect(permission).toContainText("Full Access")
  await permission.click()
  await page.getByRole("menuitemradio", { name: /Default permissions/ }).click()
  await expect(permission).toContainText("Default permissions")
  const href = page.url()
  const modifier = await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"))
  await page.keyboard.press(`${modifier}+w`)
  await expect(page).not.toHaveURL(href)
  await openProject(page, directory)
  await expect(permission).toContainText("Default permissions")
  await page.reload()
  await expect(permission).toContainText("Default permissions")
})

for (const initial of ["", "Existing input"]) {
  test(`explicit prefill is retained for an existing ${initial ? "nonempty" : "empty"} singleton`, async ({ page }) => {
    await openProject(page, directory)
    await editor(page).fill(initial)
    await sidebar(page).getByRole("button", { name: "Home", exact: true }).click()
    await page.evaluate(
      (href) => {
        const link = document.createElement("a")
        link.href = href
        link.textContent = "Prefill test input"
        document.body.append(link)
      },
      `/${base64Encode(directory)}/session?prompt=${encodeURIComponent("Explicit prefill")}`,
    )
    await page.getByRole("link", { name: "Prefill test input", exact: true }).click()
    await expect(page).toHaveURL(new URL(inputHref(directory), page.url()).href)
    await expect(editor(page)).toHaveText(initial ? `${initial}\n\nExplicit prefill` : "Explicit prefill")
    await newTask(page).click()
    await expect(editor(page)).toHaveText(initial ? `${initial}\n\nExplicit prefill` : "Explicit prefill")
    await page.goto(`${inputHref(directory)}&prompt=${encodeURIComponent("Direct prefill")}`)
    await expect(page).toHaveURL(new URL(inputHref(directory), page.url()).href)
    await expect(editor(page)).toHaveText(`${initial ? `${initial}\n\n` : ""}Explicit prefill\n\nDirect prefill`)
  })
}

test("project selection and existing worktrees open independent inputs", async ({ page }) => {
  await page.route("**/api/project", (route) =>
    route.fulfill({
      json: [
        { id: "proj-retention", worktree: directory, vcs: "git", time: {}, sandboxes: [feature] },
        { id: "proj-other", worktree: other, vcs: "git", time: {}, sandboxes: [] },
      ],
    }),
  )
  await page.route("**/experimental/worktree/options**", (route) => {
    const selected = new URL(route.request().url()).searchParams.get("directory")
    const currentBranch = selected === feature ? "feature" : selected === other ? "other" : "main"
    return route.fulfill({
      json: {
        hasHead: true,
        currentBranch,
        defaultBranch: selected === other ? "other" : "main",
        branches: selected === other ? ["other", "release"] : ["main", "release", "feature"],
      },
    })
  })
  await page.reload()
  await openProject(page, directory)
  await editor(page).fill("Root input")
  const rootURL = page.url()
  const worktreeControl = page.locator('[data-action="prompt-worktree"]')
  const worktree = page.getByRole("checkbox", { name: "Worktree", exact: true })
  await expect(worktree).toBeChecked()
  await worktreeControl.click()
  await expect(page).toHaveURL(rootURL)
  await expect(editor(page)).toHaveText("Root input")
  await page.locator('[data-action="prompt-project"]').click()
  await page.getByRole("menuitemradio", { name: /OtherProject/ }).click()
  await expect(page).toHaveURL(new URL(inputHref(other), page.url()).href)
  await expect(editor(page)).toBeEmpty()
  await editor(page).fill("Other project input")
  await openProject(page, directory)
  await expect(page).toHaveURL(rootURL)
  await expect(editor(page)).toHaveText("Root input")
  await expect(worktree).not.toBeChecked()
  await page.locator('[data-action="prompt-project"]').click()
  await page.getByRole("menuitemradio", { name: "feature", exact: true }).click()
  await expect(page).toHaveURL(new URL(inputHref(feature), page.url()).href)
  await expect(editor(page)).toBeEmpty()
  await editor(page).fill("Feature input")
  const featureURL = page.url()
  await newTask(page).click()
  await expect(page).toHaveURL(featureURL)
  await expect(editor(page)).toHaveText("Feature input")
  await expect(page.locator('[data-action="prompt-project"]')).toContainText("feature")
  await expect(page.locator('[data-action="prompt-base-branch"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-current-branch"]')).toContainText("feature")
  await worktreeControl.click()
  await expect(page).toHaveURL(featureURL)
  await expect(editor(page)).toHaveText("Feature input")
  await page.locator('[data-action="prompt-base-branch"]').click()
  await page.getByRole("menuitem", { name: "release", exact: true }).click()
  await expect(page.locator('[data-action="prompt-base-branch"]')).toContainText("release")
  await page.locator('[data-action="prompt-project"]').click()
  await page.locator(`[role="menuitemradio"][data-directory="${directory}"]`).click()
  await expect(page).toHaveURL(rootURL)
  await expect(editor(page)).toHaveText("Root input")
  await expect(page.locator('[data-action="prompt-base-branch"]')).toContainText("main")
  await page.reload()
  await expect(worktree).toBeChecked()
  await expect(editor(page)).toHaveText("Root input")
  await openProject(page, directory)
  await expect(editor(page)).toHaveText("Root input")
  await page.locator('[data-action="prompt-base-branch"]').click()
  await page.getByRole("menuitem", { name: "release", exact: true }).click()
  await expect(page.locator('[data-action="prompt-base-branch"]')).toContainText("release")
  await openProject(page, other)
  await expect(editor(page)).toHaveText("Other project input")
  await expect(page.locator('[data-action="prompt-base-branch"]')).toContainText("other")
  const otherURL = page.url()
  await page.keyboard.press("Control+Tab")
  await expect(page).toHaveURL(otherURL)
  const modifier = await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"))
  await page.keyboard.press(`${modifier}+1`)
  await expect(page.getByRole("heading", { name: "Existing conversation", exact: true })).toBeVisible()
})

for (const recovery of ["retry", "local"] as const) {
  test(`worktree options failure preserves input and supports ${recovery} recovery`, async ({ page }) => {
    await page.route("**/experimental/worktree/options**", (route) =>
      route.fulfill({ status: 500, json: { message: "Synthetic options failure" } }),
    )
    await openProject(page, directory)
    await editor(page).fill("Preserve input through options failure")
    const href = page.url()
    const send = page.getByRole("button", { name: "Send", exact: true })
    const creates: string[] = []
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === "POST" && ["/api/session", "/experimental/worktree"].includes(path)) creates.push(path)
    })
    await send.click()
    await expect(page.getByText("Choose where to run this task before sending", { exact: true })).toBeVisible()
    expect(creates).toEqual([])
    await expect(editor(page)).toHaveText("Preserve input through options failure")
    await expect(page).toHaveURL(href)
    await page.locator('[data-action="prompt-base-branch"]').click()
    await expect(page.getByRole("alert")).toHaveText("Could not load worktree options")
    if (recovery === "retry") {
      await page.route("**/experimental/worktree/options**", (route) =>
        route.fulfill({ json: { hasHead: true, currentBranch: "main", defaultBranch: "main", branches: ["main"] } }),
      )
      await page.getByRole("menuitem", { name: "Retry", exact: true }).click()
      await expect(page.locator('[data-action="prompt-base-branch"]')).toContainText("main")
      await page.keyboard.press("Escape")
      await expect(page.getByRole("checkbox", { name: "Worktree", exact: true })).toBeChecked()
    } else {
      await page.getByRole("menuitem", { name: "Use local folder", exact: true }).click()
      await expect(page.getByRole("checkbox", { name: "Worktree", exact: true })).not.toBeChecked()
      await expect(page.locator('[data-action="prompt-base-branch"]')).toHaveCount(0)
    }
    await expect(send).toBeEnabled()
    await expect(editor(page)).toHaveText("Preserve input through options failure")
    await expect(page).toHaveURL(href)
  })
}

test("repository without a commit disables worktree creation and allows local input", async ({ page }) => {
  await openProject(page, directory)
  const worktree = page.getByRole("checkbox", { name: "Worktree", exact: true })
  await expect(worktree).not.toBeChecked()
  await expect(worktree).toBeDisabled()
  await expect(page.locator('[data-action="prompt-base-branch"]')).toHaveCount(0)
  await editor(page).fill("Continue in repository without commits")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
})

test("first send creates an isolated worktree from the selected local branch", async ({ page }) => {
  const createdDirectory = `${directory}/.worktrees/new-task`
  await page.route("**/experimental/worktree/options**", (route) =>
    route.fulfill({
      json: { hasHead: true, currentBranch: "main", defaultBranch: "main", branches: ["main", "release"] },
    }),
  )
  await openProject(page, directory)
  await page.locator('[data-action="prompt-base-branch"]').click()
  await page.getByRole("menuitem", { name: "release", exact: true }).click()
  await editor(page).fill("Create from release")

  let worktreeBody: Record<string, unknown> | undefined
  await page.route("**/experimental/worktree**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== "/experimental/worktree" || route.request().method() !== "POST") return route.fallback()
    worktreeBody = route.request().postDataJSON()
    return route.fulfill({
      json: { name: "new-task", branch: "opencode/new-task", directory: createdDirectory },
    })
  })
  const created = currentSession(
    { id: "ses-worktree", title: "Worktree task", directory: createdDirectory, permissionMode: "default" },
    createdDirectory,
  )
  let sessionBody: Record<string, unknown> | undefined
  await page.route("**/api/session", (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    sessionBody = route.request().postDataJSON()
    return route.fulfill({ json: { data: created } })
  })
  await page.route("**/api/session/ses-worktree", (route) => route.fulfill({ json: { data: created } }))
  await page.route("**/api/session/ses-worktree/prompt", (route) => route.fulfill({ status: 204 }))
  const sent = page.waitForRequest("**/api/session/ses-worktree/prompt")
  await editor(page).press("Enter")
  await sent

  expect(worktreeBody).toEqual({ baseBranch: "release", wait: true })
  expect(sessionBody).toMatchObject({ location: { directory: createdDirectory } })
})

for (const change of ["switch", "edit"] as const) {
  test(`first send captures origin across an awaited create and ${change}`, async ({ page }) => {
    await openProject(page, directory)
    await editor(page).fill("Submitted from root")
    const rootURL = page.url()
    const gate = Promise.withResolvers<void>()
    const arrived = Promise.withResolvers<void>()
    let created: Record<string, unknown> | undefined
    await page.route("**/api/session", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      created = route.request().postDataJSON()
      arrived.resolve()
      await gate.promise
      return route.fulfill({
        json: { data: currentSession({ id: "ses-created", title: "Created task", directory, ...created }, directory) },
      })
    })
    await page.route("**/api/session/ses-created", (route) =>
      route.fulfill({
        json: { data: currentSession({ id: "ses-created", title: "Created task", directory }, directory) },
      }),
    )
    const sent = page.waitForRequest(
      (request) => request.method() === "POST" && request.url().includes("/ses-created/prompt"),
    )
    await page.route("**/api/session/ses-created/prompt", (route) => route.fulfill({ status: 204 }))
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
    await editor(page).press("Enter")
    await arrived.promise
    if (change === "switch") await openProject(page, other)
    await editor(page).fill("Written during create")
    const currentURL = page.url()
    gate.resolve()
    const request = await sent
    expect(request.postDataJSON()).toMatchObject({ text: "Submitted from root" })
    expect(created).toMatchObject({ location: { directory }, permissionMode: "default" })
    await expect(page).toHaveURL(currentURL)
    await expect(editor(page)).toHaveText("Written during create")
    await openProject(page, directory)
    await expect(page).toHaveURL(rootURL)
    if (change === "switch") await expect(editor(page)).toBeEmpty()
    else await expect(editor(page)).toHaveText("Written during create")
  })
}

test("create failure leaves the reusable input untouched", async ({ page }) => {
  await openProject(page, directory)
  await editor(page).fill("Retry this input")
  const href = page.url()
  await page.route("**/api/session", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, json: { message: "Synthetic create failure" } })
      : route.fallback(),
  )
  const failed = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/session"),
  )
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await editor(page).press("Enter")
  await failed
  await expect(editor(page)).toHaveText("Retry this input")
  await expect(page).toHaveURL(href)
  await page.reload()
  await expect(editor(page)).toHaveText("Retry this input")
})

test("hydration removes legacy UUID inputs but retains session text and singleton attachments and context", async ({
  page,
}) => {
  await page.route("**/experimental/worktree/options**", (route) =>
    route.fulfill({ json: { hasHead: true, currentBranch: "main", defaultBranch: "main", branches: ["main"] } }),
  )
  await editor(page).fill("Persisted formal input")
  await openProject(page, directory)
  await editor(page).fill("Persisted singleton input")
  await page.locator('input[type="file"]').setInputFiles({
    name: "retained.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64",
    ),
  })
  await expect(page.locator('[data-component="prompt-input-v2"] img')).toHaveCount(1)
  const id = new URL(page.url()).searchParams.get("draftId")!
  const legacy = "11111111-1111-4111-8111-111111111111"
  const documentKey = (id: string) =>
    `opencode.draft.${id.slice(0, 12).replace(/[^a-zA-Z0-9._-]/g, "-")}.${checksum(id)}.dat:draft:prompt`
  const key = documentKey(id)
  await expect.poll(async () => (await savedDocuments(page))[key]).toContain('"type":"image"')
  await page.evaluate(
    async ({ key, legacyKey, legacy, directory }) => {
      const request = indexedDB.open("opencode-drafts", 1)
      const db = await new Promise<IDBDatabase>((resolve) => {
        request.onsuccess = () => resolve(request.result)
      })
      const transaction = db.transaction(["documents", "blobs"], "readwrite")
      const documents = transaction.objectStore("documents")
      const saved = documents.get(key)
      saved.onsuccess = () => {
        const value = JSON.parse(saved.result)
        value.context.items.push({
          type: "file",
          path: "src/retained.ts",
          key: "file:src/retained.ts:undefined:undefined",
        })
        documents.put(JSON.stringify(value), key)
        documents.put(
          JSON.stringify({ prompt: [{ type: "image", blob: { id: "legacy-only" } }], context: { items: [] } }),
          legacyKey,
        )
        transaction.objectStore("blobs").put(new Blob(["legacy"]), "legacy-only")
      }
      await new Promise<void>((resolve) => {
        transaction.oncomplete = () => resolve()
      })
      db.close()
      const tabs = JSON.parse(localStorage.getItem("opencode.window.browser.dat:tabs") ?? "[]")
      tabs.push({ type: "draft", draftID: legacy, server: location.origin, directory })
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { key, legacyKey: documentKey(legacy), legacy, directory },
  )
  await page.reload()
  await expect(editor(page)).toHaveText("Persisted singleton input")
  await expect(page.locator('[data-component="prompt-input-v2"] img')).toHaveCount(1)
  await expect.poll(async () => (await savedDocuments(page))[documentKey(legacy)]).toBeUndefined()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("opencode.window.browser.dat:tabs")))
    .not.toContain(legacy)
  expect(JSON.parse((await savedDocuments(page))[key]!).context.items).toContainEqual(
    expect.objectContaining({ path: "src/retained.ts" }),
  )
  const retained = JSON.parse((await savedDocuments(page))[key]!)
  const inputURL = page.url()
  for (const checked of [false, true]) {
    await page.locator('[data-action="prompt-worktree"]').click()
    await expect(page.getByRole("checkbox", { name: "Worktree", exact: true })).toBeChecked({ checked })
    await expect(page).toHaveURL(inputURL)
    await expect(editor(page)).toHaveText("Persisted singleton input")
    await expect(page.locator('[data-component="prompt-input-v2"] img')).toHaveCount(1)
    expect(JSON.parse((await savedDocuments(page))[key]!)).toMatchObject({
      prompt: retained.prompt,
      context: retained.context,
    })
  }
  await sidebar(page).locator('[data-session-id="ses-retained"]').click()
  await expect(editor(page)).toHaveText("Persisted formal input")
  await page.goto(`/new-session?draftId=${legacy}`)
  await expect(page).toHaveURL(new URL("/", page.url()).href)
  await openProject(page, directory)
  await expect(editor(page)).toHaveText("Persisted singleton input")
  await expect(page.locator('[data-component="prompt-input-v2"] img')).toHaveCount(1)
})

test("first-send failure restores the created conversation without replacing newer singleton input", async ({
  page,
}) => {
  await openProject(page, directory)
  await editor(page).fill("Failed first prompt")
  const session = currentSession(
    { id: "ses-failed", title: "Failed task", directory, permissionMode: "default" },
    directory,
  )
  await page.route("**/api/session", (route) =>
    route.request().method() === "POST" ? route.fulfill({ json: { data: session } }) : route.fallback(),
  )
  await page.route("**/api/session/ses-failed", (route) => route.fulfill({ json: { data: session } }))
  const gate = Promise.withResolvers<void>()
  const arrived = page.waitForRequest("**/api/session/ses-failed/prompt")
  await page.route("**/api/session/ses-failed/prompt", async (route) => {
    await gate.promise
    await route.fulfill({ status: 500, json: { message: "Synthetic send failure" } })
  })
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  await editor(page).press("Enter")
  await arrived
  await expect(page.getByRole("heading", { name: "Failed task", exact: true })).toBeVisible()
  const sessionURL = page.url()
  await openProject(page, directory)
  await expect(editor(page)).toBeEmpty()
  await editor(page).fill("New singleton input")
  const failed = page.waitForResponse("**/api/session/ses-failed/prompt")
  gate.resolve()
  await failed
  await expect(editor(page)).toHaveText("New singleton input")
  await page.goto(sessionURL)
  await expect(editor(page)).toHaveText("Failed first prompt")
})

async function savedDocuments(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("opencode-drafts", 1)
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result)
    })
    const store = db.transaction("documents").objectStore("documents")
    const keys = store.getAllKeys()
    const values = store.getAll()
    const result = await new Promise<Record<string, string>>((resolve) => {
      values.onsuccess = () => resolve(Object.fromEntries(keys.result.map((key, i) => [String(key), values.result[i]])))
    })
    db.close()
    return result
  })
}
