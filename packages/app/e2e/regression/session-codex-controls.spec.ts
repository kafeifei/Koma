import { base64Encode } from "@opencode-ai/core/util/encode"
import type { LabDescribeOutput, LabEnginesOutput, LabSnapshotOutput } from "@opencode-ai/lab-client"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const directory = "/tmp/opencode-lab-codex-controls"
const sessionID = "ses_codex_controls"
const childID = "ses_codex_child"
const title = "Codex native controls"
const childTitle = "Native child"
const epoch = "codex-controls-e2e"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const capabilities = {
  prompt: true,
  steer: true,
  queue: "native" as const,
  compact: true,
  images: true,
  permissions: true,
}

type ReplyBody = {
  revision: number
  choiceID?: string
  answers?: Record<string, string[]>
  content?: unknown
}
type QueueBody = { action: "resume" | "withdraw"; requestID: string; revision: number }
type Harness = {
  current: LabSnapshotOutput
  newLayout?: boolean
  account?: LabEnginesOutput[number]["account"]
  replies: { interactionID: string; body: ReplyBody }[]
  queue: QueueBody[]
  deliveryReads: string[]
  loginStarts?: string[]
  loginCancels?: string[]
  afterReply?: (interactionID: string, body: ReplyBody, current: LabSnapshotOutput) => LabSnapshotOutput
  afterQueue?: (body: QueueBody, current: LabSnapshotOutput) => LabSnapshotOutput
  afterDelivery?: (requestID: string, current: LabSnapshotOutput) => LabSnapshotOutput["deliveries"][number]
  beforeChildDescribe?: () => Promise<void>
  beforeChildSnapshot?: () => Promise<void>
}

test.use({ viewport: { width: 1440, height: 1000 } })

for (const newLayout of [false, true]) {
  test(`deletes a native task from the ${newLayout ? "new" : "legacy"} timeline and retries a conflict`, async ({
    page,
  }) => {
    const harness: Harness = {
      current: snapshot(30, { deleteCapability: true }),
      newLayout,
      replies: [],
      queue: [],
      deliveryReads: [],
    }
    await setup(page, harness)
    const deletes: string[] = []
    await page.route(`**/api/session/${sessionID}**`, (route) => {
      if (route.request().method() !== "DELETE") return route.fallback()
      deletes.push(new URL(route.request().url()).pathname)
      if (deletes.length === 1) return route.fulfill({ status: 409, json: { message: "Native task changed" } })
      return route.fulfill({ status: 204 })
    })
    await open(page)

    const sidebarTask = page
      .locator('[data-component="task-sidebar"]')
      .locator(`[data-slot="workspace-task-row"]:has([data-session-id="${sessionID}"])`)
    await sidebarTask.click({ button: "right" })
    await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeEnabled()
    await page.keyboard.press("Escape")

    await page.locator("[data-session-title]").getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: /^Delete(?:\.\.\.)?$/ }).click()
    const dialog = page.getByRole("dialog")
    const remove = dialog.getByRole("button", { name: "Delete session", exact: true })
    const firstRequest = page.waitForRequest(
      (request) => request.method() === "DELETE" && new URL(request.url()).pathname === `/api/session/${sessionID}`,
    )
    await remove.click()
    await firstRequest
    await expect(dialog).toBeVisible()
    await expect(page.getByText("Native task changed", { exact: true })).toBeVisible()
    expect(deletes).toEqual([`/api/session/${sessionID}`])

    const retryRequest = page.waitForRequest(
      (request) => request.method() === "DELETE" && new URL(request.url()).pathname === `/api/session/${sessionID}`,
    )
    await remove.click()
    await retryRequest
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(sessionHref(childID))
    await expectSessionTitle(page, childTitle)
    expect(deletes).toEqual([`/api/session/${sessionID}`, `/api/session/${sessionID}`])
  })
}

test("keeps native deletion unavailable when the descriptor omits the capability", async ({ page }) => {
  const harness: Harness = {
    current: snapshot(31),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  await open(page)

  const sidebarTask = page
    .locator('[data-component="task-sidebar"]')
    .locator(`[data-slot="workspace-task-row"]:has([data-session-id="${sessionID}"])`)
  await sidebarTask.click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeDisabled()
  await page.keyboard.press("Escape")
  await page.locator("[data-session-title]").getByRole("button", { name: "More options", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: /^Delete(?:\.\.\.)?$/ })).toHaveCount(0)
})

test("keeps native deletion unavailable when ordinary session deletion is disabled", async ({ page }) => {
  const harness: Harness = {
    current: snapshot(32, { deleteCapability: true }),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  await page.route("**/api/session/capabilities", (route) =>
    route.fulfill({
      json: {
        data: {
          archive: true,
          restore: true,
          delete: false,
          managedWorktree: false,
          occupancy: { pty: false, v2: false, externalProcesses: false },
        },
      },
    }),
  )
  await open(page)

  const sidebarTask = page
    .locator('[data-component="task-sidebar"]')
    .locator(`[data-slot="workspace-task-row"]:has([data-session-id="${sessionID}"])`)
  await sidebarTask.click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeDisabled()
  await page.keyboard.press("Escape")
  await page.locator("[data-session-title]").getByRole("button", { name: "More options", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: /^Delete(?:\.\.\.)?$/ })).toHaveCount(0)
})

test("keeps ordinary OpenCode deletion available without an external capability", async ({ page }) => {
  const harness: Harness = {
    current: snapshot(33, { engine: "opencode" }),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  await open(page)

  const sidebarTask = page
    .locator('[data-component="task-sidebar"]')
    .locator(`[data-slot="workspace-task-row"]:has([data-session-id="${sessionID}"])`)
  await sidebarTask.click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeEnabled()
  await page.keyboard.press("Escape")
  await page.locator("[data-session-title]").getByRole("button", { name: "More options", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: /^Delete(?:\.\.\.)?$/ })).toBeVisible()
})

test("keeps ordinary OpenCode deletion visible but disabled when session deletion is disabled", async ({ page }) => {
  const harness: Harness = {
    current: snapshot(34, { engine: "opencode" }),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  await page.route("**/api/session/capabilities", (route) =>
    route.fulfill({
      json: {
        data: {
          archive: true,
          restore: true,
          delete: false,
          managedWorktree: false,
          occupancy: { pty: false, v2: false, externalProcesses: false },
        },
      },
    }),
  )
  await open(page)

  const sidebarTask = page
    .locator('[data-component="task-sidebar"]')
    .locator(`[data-slot="workspace-task-row"]:has([data-session-id="${sessionID}"])`)
  await sidebarTask.click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeDisabled()
  await page.keyboard.press("Escape")
  await page.locator("[data-session-title]").getByRole("button", { name: "More options", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: /^Delete(?:\.\.\.)?$/ })).toBeDisabled()
})

test("keeps the ordinary Codex composer free of persistent control chrome", async ({ page }) => {
  const harness: Harness = {
    current: snapshot(31),
    account: { authenticated: false, requiresAuth: false },
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  const controls = await open(page)
  await expect(controls).toHaveCount(0)
  await expect(page.locator('[data-component="codex-session-controls"]')).toHaveCount(0)
  await expect(page.locator('[data-component="prompt-input-v2"]')).toBeVisible()
  await expect(page.getByText("Connected", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Codex is ready", { exact: true })).toHaveCount(0)
})

test("keeps the composer available for nonblocking interactions and hides it while the backend waits", async ({
  page,
}) => {
  const transport = await installSseTransport(page, { server, retry: 20 })
  const command = interaction({
    id: "native-nonblocking-command",
    revision: 35,
    kind: "command",
    title: "Review native command",
    choices: [
      { id: "opaque-command-once", kind: "allow" },
      { id: "opaque-command-deny", kind: "deny" },
    ],
  })
  const harness: Harness = {
    current: snapshot(35, { interactions: [command], runtimeStatus: "active" }),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  const controls = await open(page)
  await transport.waitForConnection()
  await expect(controls.locator(`[data-interaction-id="${command.id}"]`)).toBeVisible()
  await expect(page.locator('[data-component="prompt-input-v2"]')).toBeVisible()

  harness.current = snapshot(36, { interactions: [command], runtimeStatus: "waitingApproval" })
  await sendRefresh(transport, harness.current.descriptor)
  await expect(page.locator('[data-component="prompt-input-v2"]')).toHaveCount(0)

  harness.current = snapshot(37)
  await sendRefresh(transport, harness.current.descriptor)
  await expect(controls).toHaveCount(0)
  await expect(page.locator('[data-component="prompt-input-v2"]')).toBeVisible()
})

test("opens a mapped native subagent from its tool card without linking an unmapped native thread", async ({
  page,
}) => {
  const mappedPartID = "prt_codex_subagent_mapped"
  const unmappedPartID = "prt_codex_subagent_unmapped"
  const nativeThreadID = "native-thread-child"
  const unmappedNativeThreadID = "native-thread-unmapped"
  const harness: Harness = {
    current: snapshot(38, {
      children: [{ sessionID: childID, nativeThreadID }],
      messages: [
        subagentMessage([
          subagentTool(mappedPartID, nativeThreadID, childID),
          subagentTool(unmappedPartID, unmappedNativeThreadID),
        ]),
      ],
    }),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  await open(page)

  const mapped = page.locator(`[data-timeline-part-id="${mappedPartID}"]`)
  const unmapped = page.locator(`[data-timeline-part-id="${unmappedPartID}"]`)
  await expect(mapped).toBeVisible()
  await expect(unmapped).toBeVisible()
  await expect(mapped.locator(`a[href="${sessionHref(childID)}"]`)).toBeVisible()
  await expect(unmapped.getByRole("link")).toHaveCount(0)
  await expect(unmapped.locator('[data-component="task-tool-action"]')).toHaveCount(0)
  await expect(page.locator(`a[href="${sessionHref(nativeThreadID)}"]`)).toHaveCount(0)
  await expect(page.locator(`a[href="${sessionHref(unmappedNativeThreadID)}"]`)).toHaveCount(0)
  await unmapped.getByRole("button").click()
  await expect(page).toHaveURL(sessionHref(sessionID))

  await mapped.locator(`a[href="${sessionHref(childID)}"]`).click()
  const preview = page.getByRole("complementary", { name: "Side workspace" })
  await expect(preview.getByText(childTitle, { exact: true })).toBeVisible()
  await expect(preview.getByRole("link", { name: "Open full task", exact: true })).toHaveAttribute(
    "href",
    sessionHref(childID),
  )
  await expect(page).toHaveURL(sessionHref(sessionID))
  await preview.getByRole("link", { name: "Open full task", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${childID}$`))
  await expectSessionTitle(page, childTitle)
})

test("settles native login cancellation and failure through the account snapshot", async ({ page }) => {
  const transport = await installSseTransport<{
    id: string
    type: "session.external.engine.changed"
    location: { directory: string }
    data: { engine: "codex" }
  }>(page, { server, retry: 20 })
  const harness: Harness = {
    current: snapshot(32),
    account: { authenticated: false, requiresAuth: true },
    replies: [],
    queue: [],
    deliveryReads: [],
    loginStarts: [],
    loginCancels: [],
  }
  await setup(page, harness)
  await page
    .context()
    .route("https://example.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>Codex login</title>" }),
    )
  const controls = await open(page)
  await transport.waitForConnection()

  const firstPopup = page.waitForEvent("popup")
  await controls.getByRole("button", { name: "Sign in to Codex" }).click()
  await (await firstPopup).close()
  await expect(controls.getByText("Waiting for sign-in", { exact: true })).toBeVisible()
  await controls.getByRole("button", { name: "Cancel sign-in" }).click()
  await expect.poll(() => harness.loginCancels).toEqual(["native-login-1"])
  await expect(controls.getByText("Waiting for sign-in", { exact: true })).toHaveCount(0)
  await expect(controls.getByRole("button", { name: "Sign in to Codex" })).toBeVisible()

  const secondPopup = page.waitForEvent("popup")
  await controls.getByRole("button", { name: "Sign in to Codex" }).click()
  await (await secondPopup).close()
  await expect(controls.getByText("Waiting for sign-in", { exact: true })).toBeVisible()
  harness.account = {
    authenticated: false,
    requiresAuth: true,
    loginState: "failed",
    error: "Native login expired",
  }
  await transport.send(
    {
      id: "evt_codex_login_failed",
      type: "session.external.engine.changed",
      location: { directory },
      data: { engine: "codex" },
    },
    { id: "sse_codex_login_failed" },
  )

  await expect(controls.getByText("Waiting for sign-in", { exact: true })).toHaveCount(0)
  await expect(controls.getByRole("button", { name: "Cancel sign-in" })).toHaveCount(0)
  await expect(controls.getByRole("button", { name: "Sign in to Codex" })).toBeVisible()
  await expect(controls.getByText("Native login expired", { exact: true })).toBeVisible()
  expect(harness.loginStarts).toEqual(["native-login-1", "native-login-2"])
})

test("shows only an available native plan and hides it when the report becomes unavailable", async ({ page }) => {
  const transport = await installSseTransport<{
    id: string
    type: "session.external.changed"
    location: { directory: string }
    data: {
      sessionID: string
      epoch: string
      revision: number
      descriptor: LabDescribeOutput[number]
      refresh: true
    }
  }>(page, { server, retry: 20 })
  const harness: Harness = {
    current: snapshot(71, { plan: { status: "loading" } }),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  const controls = await open(page)
  await transport.waitForConnection()
  const plan = controls.locator('[data-component="codex-plan-dock"]')
  await expect(plan).toHaveCount(0)

  harness.current = snapshot(72, {
    plan: {
      status: "available",
      value: {
        turnID: "native-turn-plan",
        explanation: "Inspect the native state before changing it.",
        steps: [
          { step: "Inspect native state", status: "inProgress" },
          { step: "Apply the focused change", status: "pending" },
        ],
      },
    },
  })
  await sendRefresh(transport, harness.current.descriptor)
  await expect(plan.locator('[data-component="session-todo-dock"]')).toBeVisible()
  await expect(plan.locator('[data-state="in_progress"]')).toContainText("Inspect native state")
  await expect(plan.locator('[data-state="pending"]')).toContainText("Apply the focused change")
  await expect(plan.getByText("Inspect the native state before changing it.", { exact: true })).toHaveCount(0)

  harness.current = snapshot(73, {
    plan: {
      status: "available",
      value: {
        turnID: "native-turn-plan",
        explanation: "The inspection is complete.",
        steps: [
          { step: "Inspect native state", status: "completed" },
          { step: "Apply the focused change", status: "inProgress" },
        ],
      },
    },
  })
  await sendRefresh(transport, harness.current.descriptor)
  await expect(plan.locator('[data-state="completed"]')).toContainText("Inspect native state")
  await expect(plan.locator('[data-state="in_progress"]')).toContainText("Apply the focused change")
  await expect(plan.getByText("The inspection is complete.", { exact: true })).toHaveCount(0)

  harness.current = snapshot(74, { plan: { status: "unavailable" } })
  await sendRefresh(transport, harness.current.descriptor)
  await expect(plan).toHaveCount(0)
})

test("submits exact native command choices and preserves secret answers", async ({ page }) => {
  const command = interaction({
    id: "native-command",
    revision: 41,
    kind: "command",
    title: "Approve native command",
    choices: [
      { id: "opaque-command-once", kind: "allow" },
      { id: "opaque-command-session", kind: "allowSession" },
      { id: "opaque-command-deny", kind: "deny" },
    ],
  })
  const questions = interaction({
    id: "native-questions",
    revision: 42,
    kind: "question",
    title: "Native questions",
    choices: [],
    questions: [
      {
        id: "mode-question",
        header: "Mode",
        question: "Choose a mode",
        options: [{ label: "Safe", description: "Use guarded execution" }],
      },
      {
        id: "secret-question",
        header: "Token",
        question: "Enter the exact token",
        secret: true,
      },
    ],
  })
  const harness: Harness = {
    current: snapshot(41, { interactions: [command] }),
    replies: [],
    queue: [],
    deliveryReads: [],
    afterReply: (interactionID) =>
      interactionID === command.id ? snapshot(42, { interactions: [questions] }) : snapshot(43),
  }
  await setup(page, harness)
  const controls = await open(page)

  const commandCard = controls.locator(`[data-interaction-id="${command.id}"]`)
  await expect(commandCard.locator("[data-choice-id]")).toHaveCount(3)
  await commandCard.locator('[data-choice-id="opaque-command-session"]').click()
  await expect.poll(() => harness.replies.length).toBe(1)
  expect(harness.replies[0]).toEqual({
    interactionID: command.id,
    body: { revision: 41, choiceID: "opaque-command-session" },
  })

  const questionCard = controls.locator(`[data-interaction-id="${questions.id}"]`)
  await expect(questionCard).toBeVisible()
  await questionCard.getByText("Safe", { exact: true }).click()
  await questionCard.locator('input[type="password"]').fill("  secret bytes  ")
  await questionCard.locator('[data-action="reply-questions"]').click()
  await expect.poll(() => harness.replies.length).toBe(2)
  expect(harness.replies[1]).toEqual({
    interactionID: questions.id,
    body: {
      revision: 42,
      answers: {
        "mode-question": ["Safe"],
        "secret-question": ["  secret bytes  "],
      },
    },
  })
})

test("keeps MCP decline available until a typed form is valid and opens URL elicitations", async ({ page }) => {
  const invalidForm = formInteraction("mcp-form-invalid", 51)
  const validForm = formInteraction("mcp-form-valid", 52)
  const url = interaction({
    id: "mcp-url",
    revision: 53,
    kind: "url",
    title: "Authorize MCP server",
    url: "https://example.test/native-auth",
    choices: [
      { id: "opaque-url-accept", kind: "allow" },
      { id: "opaque-url-decline", kind: "deny" },
      { id: "opaque-url-cancel", kind: "cancel" },
    ],
  })
  const harness: Harness = {
    current: snapshot(51, { interactions: [invalidForm] }),
    replies: [],
    queue: [],
    deliveryReads: [],
    afterReply: (interactionID) => {
      if (interactionID === invalidForm.id) return snapshot(52, { interactions: [validForm] })
      if (interactionID === validForm.id) return snapshot(53, { interactions: [url] })
      return snapshot(54)
    },
  }
  await setup(page, harness)
  const controls = await open(page)

  const invalidCard = controls.locator(`[data-interaction-id="${invalidForm.id}"]`)
  await expect(invalidCard.locator('[data-choice-id="opaque-form-accept"]')).toBeDisabled()
  await expect(invalidCard.locator('[data-choice-id="opaque-form-cancel"]')).toBeEnabled()
  await invalidCard.locator('[data-choice-id="opaque-form-cancel"]').click()
  await expect.poll(() => harness.replies.length).toBe(1)
  expect(harness.replies[0]).toEqual({
    interactionID: invalidForm.id,
    body: { revision: 51, choiceID: "opaque-form-cancel" },
  })

  const formCard = controls.locator(`[data-interaction-id="${validForm.id}"]`)
  await formCard.getByLabel("Name").fill("worker")
  await formCard.getByLabel("Count").fill("3")
  await formCard.getByText("Fast", { exact: true }).click()
  await formCard.getByText("Enabled", { exact: true }).click()
  await expect(formCard.locator('[data-choice-id="opaque-form-accept"]')).toBeEnabled()
  await formCard.locator('[data-choice-id="opaque-form-accept"]').click()
  await expect.poll(() => harness.replies.length).toBe(2)
  expect(harness.replies[1]).toEqual({
    interactionID: validForm.id,
    body: {
      revision: 52,
      choiceID: "opaque-form-accept",
      content: { name: "worker", count: 3, mode: "opaque-fast", enabled: true },
    },
  })

  const urlCard = controls.locator(`[data-interaction-id="${url.id}"]`)
  await page
    .context()
    .route("https://example.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>Native auth</title>" }),
    )
  const popupPromise = page.waitForEvent("popup")
  await urlCard.locator('[data-action="open-url"]').click()
  const popup = await popupPromise
  expect(popup.url()).toBe(url.url)
  await popup.close()
  await urlCard.locator('[data-choice-id="opaque-url-accept"]').click()
  await expect.poll(() => harness.replies.length).toBe(3)
  expect(harness.replies[2]).toEqual({
    interactionID: url.id,
    body: { revision: 53, choiceID: "opaque-url-accept" },
  })
})

test("refreshes unknown receipts, then resumes and withdraws the paused queue", async ({ page }) => {
  const unknown = delivery("receipt-unknown", "steer", "unknown")
  const resume = delivery("receipt-resume", "queue", "pending")
  const withdraw = delivery("receipt-withdraw", "queue", "pending")
  const harness: Harness = {
    current: snapshot(61, {
      queuePaused: true,
      deliveries: [unknown, resume, withdraw],
    }),
    replies: [],
    queue: [],
    deliveryReads: [],
    afterDelivery: (requestID, current) => {
      const accepted = {
        ...current.deliveries.find((item) => item.requestID === requestID)!,
        state: "accepted" as const,
        nativeItemID: "confirmed-user-item",
      }
      harness.current = {
        ...current,
        deliveries: current.deliveries.map((item) => (item.requestID === requestID ? accepted : item)),
      }
      return accepted
    },
    afterQueue: (body, current) => {
      if (body.action === "resume") {
        return snapshot(62, {
          queuePaused: false,
          deliveries: current.deliveries.map((item) =>
            item.requestID === resume.requestID ? { ...item, state: "accepted" as const } : item,
          ),
        })
      }
      return snapshot(63, {
        queuePaused: false,
        deliveries: current.deliveries.map((item) =>
          item.requestID === withdraw.requestID ? { ...item, state: "withdrawn" as const } : item,
        ),
      })
    },
  }
  await setup(page, harness)
  const controls = await open(page)

  const unknownRow = controls.locator(`[data-delivery-id="${unknown.requestID}"]`)
  await unknownRow.locator('[data-action="check-delivery"]').click()
  await expect.poll(() => harness.deliveryReads).toEqual([unknown.requestID])
  await expect(unknownRow.locator('[data-action="check-delivery"]')).toHaveCount(0)

  await controls.locator('[data-action="resume-queue"]').click()
  await expect.poll(() => harness.queue.length).toBe(1)
  expect(harness.queue[0]).toEqual({ action: "resume", requestID: resume.requestID, revision: 61 })

  const withdrawRow = controls.locator(`[data-delivery-id="${withdraw.requestID}"]`)
  await withdrawRow.locator('[data-action="withdraw-delivery"]').click()
  await expect.poll(() => harness.queue.length).toBe(2)
  expect(harness.queue[1]).toEqual({ action: "withdraw", requestID: withdraw.requestID, revision: 62 })
})

test("keeps unconfirmed receipts and copies text only into an empty stopped composer", async ({ page }) => {
  const unconfirmed = { ...delivery("receipt-unconfirmed", "steer", "accepted"), nativeTurnID: "native-turn" }
  const harness: Harness = {
    current: snapshot(70, { runtimeStatus: "active", deliveries: [unconfirmed] }),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  const controls = await open(page)
  const row = controls.locator(`[data-delivery-id="${unconfirmed.requestID}"]`)
  const copy = row.locator('[data-action="copy-delivery-text"]')
  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await expect(row).toBeVisible()
  await expect(copy).toHaveCount(0)

  await editor.fill("Keep this draft")
  harness.current = snapshot(71, { runtimeStatus: "idle", queuePaused: true, deliveries: [unconfirmed] })
  await row.locator('[data-action="check-delivery"]').click()
  await expect(editor).toHaveText("Keep this draft")
  await expect(copy).toHaveCount(0)
  await editor.fill("")
  harness.current = snapshot(72, { runtimeStatus: "disconnected", queuePaused: true, deliveries: [unconfirmed] })
  await row.locator('[data-action="check-delivery"]').click()
  await expect(copy).toHaveCount(0)
  harness.current = snapshot(73, { runtimeStatus: "idle", queuePaused: true, deliveries: [unconfirmed] })
  await row.locator('[data-action="check-delivery"]').click()
  await expect(copy).toBeVisible()
  await copy.click()
  await expect(editor).toHaveText(unconfirmed.input.prompt.text)
  await expect(row).toBeVisible()
  await expect(copy).toHaveCount(0)
  expect(harness.queue).toEqual([])

  harness.current = snapshot(74, {
    runtimeStatus: "idle",
    queuePaused: true,
    deliveries: [{ ...unconfirmed, nativeItemID: "native-item-1" }],
  })
  await row.locator('[data-action="check-delivery"]').click()
  await expect(row).toHaveCount(0)
  await expect(editor).toHaveText(unconfirmed.input.prompt.text)
})

for (const state of ["paused", "returned"] as const) {
  test(`resumes a ${state} immediate input only after an explicit action and preserves the draft`, async ({ page }) => {
    const retained = delivery(`receipt-${state}`, "steer", state)
    const uncertain = delivery("receipt-uncertain", "steer", "unknown")
    const harness: Harness = {
      current: snapshot(80, { queuePaused: true, deliveries: [retained, uncertain] }),
      replies: [],
      queue: [],
      deliveryReads: [],
      afterQueue: (body, current) =>
        snapshot(81, {
          queuePaused: false,
          deliveries: current.deliveries.map((item) =>
            item.requestID === body.requestID
              ? { ...item, state: "accepted" as const, nativeItemID: "confirmed-resumed-item" }
              : item,
          ),
        }),
    }
    await setup(page, harness)
    const controls = await open(page)
    const row = controls.locator(`[data-delivery-id="${retained.requestID}"]`)
    const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await expect(row).toContainText(state === "paused" ? "Paused" : "Not delivered")
    await expect(row.locator('[data-action="withdraw-delivery"]')).toBeVisible()
    await expect(
      controls.locator(`[data-delivery-id="${uncertain.requestID}"] [data-action="resume-queue"]`),
    ).toHaveCount(0)
    await editor.fill("Keep my new draft")
    expect(harness.queue).toEqual([])
    await row.locator('[data-action="resume-queue"]').click()
    await expect.poll(() => harness.queue).toEqual([{ action: "resume", requestID: retained.requestID, revision: 80 }])
    await expect(row).toHaveCount(0)
    await expect(editor).toHaveText("Keep my new draft")
  })
}

test("waits for backend-confirmed idle before allowing a paused queue to resume", async ({ page }) => {
  const transport = await installSseTransport(page, { server, retry: 20 })
  const queued = delivery("paused-queue", "queue", "paused")
  const harness: Harness = {
    current: snapshot(85, { runtimeStatus: "interrupting", queuePaused: true, deliveries: [queued] }),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  const controls = await open(page)
  await transport.waitForConnection()
  const resume = controls.locator('[data-action="resume-queue"]')
  await expect(resume).toBeDisabled()
  harness.current = snapshot(86, { runtimeStatus: "idle", queuePaused: true, deliveries: [queued] })
  await sendRefresh(transport, harness.current.descriptor)
  await expect(resume).toBeEnabled()
  expect(harness.queue).toEqual([])
})

test("projects backend input wait reasons into the existing delivery row", async ({ page }) => {
  const reasons = [
    ["earlierInput", "Waiting for an earlier input."],
    ["waitingApproval", "Waiting for approval"],
    ["waitingInput", "Waiting for input"],
    ["waitingForIdle", "Waiting for the current turn to finish."],
    ["waitingForConfiguration", "Waiting for the next turn to apply the selected settings."],
  ] as const
  const harness: Harness = {
    current: snapshot(90, {
      deliveries: reasons.map(([waitReason]) => ({ ...delivery(waitReason, "steer", "pending"), waitReason })),
    }),
    replies: [],
    queue: [],
    deliveryReads: [],
  }
  await setup(page, harness)
  const controls = await open(page)
  for (const [reason, label] of reasons) {
    await expect(controls.locator(`[data-delivery-id="${reason}"]`)).toContainText(label)
  }
  expect(harness.queue).toEqual([])
})

async function setup(page: Page, harness: Harness) {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: "project-codex-controls",
      worktree: directory,
      vcs: "git",
      name: "codex-controls",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [{ id: "codex", name: "Codex", models: { "gpt-6": { id: "gpt-6", name: "GPT-6" } } }],
      connected: ["codex"],
      default: { providerID: "codex", modelID: "gpt-6" },
    },
    sessions: [session(sessionID, title, harness.current.descriptor.engine), session(childID, childTitle)],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/session/capabilities", (route) =>
    route.fulfill({
      json: {
        data: {
          archive: true,
          restore: true,
          delete: true,
          managedWorktree: false,
          occupancy: { pty: false, v2: false, externalProcesses: false },
        },
      },
    }),
  )
  await page.route("**/lab/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== server) return route.fallback()
    if (url.pathname === "/lab/engines")
      return json(route, [
        {
          id: "codex",
          available: true,
          version: "e2e",
          account: harness.account ?? { authenticated: true, requiresAuth: false, label: "codex@example.test" },
          capabilities,
          models: [{ id: "gpt-6", name: "GPT-6", default: true, efforts: ["high"], defaultEffort: "high" }],
        },
      ])
    if (url.pathname === "/lab/engines/codex/login" && route.request().method() === "POST") {
      const loginID = `native-login-${(harness.loginStarts?.length ?? 0) + 1}`
      harness.loginStarts?.push(loginID)
      return json(route, { loginID, url: `https://example.test/${loginID}` })
    }
    if (url.pathname === "/lab/engines/codex/login/cancel" && route.request().method() === "POST") {
      const body = postBody(route)
      if (typeof body.loginID !== "string") throw new Error("Expected a login ID")
      harness.loginCancels?.push(body.loginID)
      return json(route, harness.account ?? { authenticated: false, requiresAuth: true })
    }
    if (url.pathname === "/lab/sessions/describe") {
      const body = postBody(route)
      const sessionIDs = Array.isArray(body.sessionIDs)
        ? body.sessionIDs.filter((value): value is string => typeof value === "string")
        : []
      if (sessionIDs.includes(childID)) await harness.beforeChildDescribe?.()
      return json(
        route,
        sessionIDs.flatMap((id) => {
          if (id === sessionID) return [harness.current.descriptor]
          if (id === childID) return [descriptor(childID, 1)]
          return []
        }),
      )
    }
    if (url.pathname === `/lab/sessions/${sessionID}` && route.request().method() === "GET") {
      return json(route, harness.current)
    }
    if (url.pathname === `/lab/sessions/${childID}` && route.request().method() === "GET") {
      await harness.beforeChildSnapshot?.()
      return json(route, snapshot(1, { sessionID: childID }))
    }
    const reply = url.pathname.match(new RegExp(`^/lab/sessions/${sessionID}/interactions/([^/]+)/reply$`))
    if (reply && route.request().method() === "POST") {
      const body = replyBody(route)
      harness.replies.push({ interactionID: reply[1], body })
      harness.current = harness.afterReply?.(reply[1], body, harness.current) ?? harness.current
      return json(route, harness.current)
    }
    const receipt = url.pathname.match(new RegExp(`^/lab/sessions/${sessionID}/deliveries/([^/]+)$`))
    if (receipt && route.request().method() === "GET") {
      harness.deliveryReads.push(receipt[1])
      const result = harness.afterDelivery?.(receipt[1], harness.current)
      return json(route, result ?? harness.current.deliveries.find((item) => item.requestID === receipt[1]))
    }
    if (url.pathname === `/lab/sessions/${sessionID}/queue` && route.request().method() === "POST") {
      const body = queueBody(route)
      harness.queue.push(body)
      harness.current = harness.afterQueue?.(body, harness.current) ?? harness.current
      return json(route, harness.current)
    }
    return json(route, { message: `Unexpected Lab request: ${url.pathname}` }, 404)
  })
  await page.addInitScript(
    ({ directory, server, sessionID, newLayout }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: newLayout } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [server],
          projects: { [server]: [{ worktree: directory, expanded: true }] },
          lastProject: { [server]: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { directory, server, sessionID, newLayout: harness.newLayout ?? true },
  )
}

async function open(page: Page) {
  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  return page.locator('[data-component="codex-session-docks"]')
}

function descriptor(id: string, revision: number, queuePaused = false): LabDescribeOutput[number] {
  return {
    sessionID: id,
    engine: "codex",
    epoch,
    revision,
    runtimeStatus: "idle",
    bindingState: "bound",
    capabilities,
    queuePaused,
    settings: { model: "gpt-6", effort: "high", permission: "workspace" },
  }
}

function snapshot(
  revision: number,
  options: {
    sessionID?: string
    queuePaused?: boolean
    interactions?: LabSnapshotOutput["interactions"]
    deliveries?: LabSnapshotOutput["deliveries"]
    children?: LabSnapshotOutput["children"]
    messages?: LabSnapshotOutput["messages"]
    plan?: LabSnapshotOutput["plan"]
    runtimeStatus?: LabDescribeOutput[number]["runtimeStatus"]
    deleteCapability?: boolean
    engine?: LabDescribeOutput[number]["engine"]
  } = {},
): LabSnapshotOutput {
  const id = options.sessionID ?? sessionID
  return {
    descriptor: {
      ...descriptor(id, revision, options.queuePaused),
      engine: options.engine ?? "codex",
      runtimeStatus: options.runtimeStatus ?? "idle",
      capabilities: {
        ...capabilities,
        ...(options.deleteCapability === undefined ? {} : { delete: options.deleteCapability }),
      },
    },
    messages: options.messages ?? [],
    messageOrder: options.messages?.map((message) => message.id) ?? [],
    partOrder: Object.fromEntries(
      (options.messages ?? []).flatMap((message) =>
        message.type === "assistant" ? [[message.id, message.content.map((part) => part.id)]] : [],
      ),
    ),
    interactions: options.interactions ?? [],
    deliveries: options.deliveries ?? [],
    usage: { status: "unavailable" },
    contextWindow: { status: "unavailable" },
    cost: { status: "unavailable" },
    turnDiffs: {},
    sessionDiff: { status: "unavailable" },
    plan: options.plan,
    children: options.children ?? [],
  }
}

function subagentMessage(
  content: Extract<LabSnapshotOutput["messages"][number], { type: "assistant" }>["content"],
): Extract<LabSnapshotOutput["messages"][number], { type: "assistant" }> {
  return {
    id: "msg_codex_subagents",
    type: "assistant",
    orderKey: "codex_order_subagents",
    time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 },
    agent: "codex",
    model: { providerID: "codex", id: "gpt-6" },
    content,
  }
}

function subagentTool(
  id: string,
  nativeThreadID: string,
  mappedSessionID?: string,
): Extract<Extract<LabSnapshotOutput["messages"][number], { type: "assistant" }>["content"][number], { type: "tool" }> {
  return {
    id,
    type: "tool",
    name: "codex.subagent",
    time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 },
    state: {
      status: "completed",
      input: {
        operation: "spawnAgent",
        description: mappedSessionID ? "Inspect mapped child" : "Inspect unmapped native child",
        nativeSubagent: true,
        nativeThreadID,
        ...(mappedSessionID ? { sessionId: mappedSessionID } : {}),
      },
      content: [{ type: "text", text: "Subagent completed" }],
      structured: {
        nativeSubagent: true,
        nativeThreadID,
        ...(mappedSessionID ? { sessionId: mappedSessionID } : {}),
      },
    },
  }
}

function interaction(
  input: Pick<LabSnapshotOutput["interactions"][number], "id" | "revision" | "kind" | "title" | "choices"> &
    Partial<LabSnapshotOutput["interactions"][number]>,
): LabSnapshotOutput["interactions"][number] {
  return { sessionID, state: "pending", ...input }
}

function formInteraction(id: string, revision: number) {
  return interaction({
    id,
    revision,
    kind: "form",
    title: "MCP typed form",
    choices: [
      { id: "opaque-form-accept", kind: "allow" },
      { id: "opaque-form-decline", kind: "deny" },
      { id: "opaque-form-cancel", kind: "cancel" },
    ],
    requestedSchema: {
      type: "object",
      required: ["name", "count", "mode"],
      properties: {
        name: { type: "string", title: "Name", minLength: 2 },
        count: { type: "integer", title: "Count", minimum: 1, maximum: 5 },
        mode: {
          type: "string",
          title: "Mode",
          oneOf: [
            { const: "opaque-safe", title: "Safe" },
            { const: "opaque-fast", title: "Fast" },
          ],
        },
        enabled: { type: "boolean", title: "Enabled", default: false },
      },
    },
  })
}

function delivery(
  requestID: string,
  mode: "steer" | "queue",
  state: LabSnapshotOutput["deliveries"][number]["state"],
): LabSnapshotOutput["deliveries"][number] {
  return {
    sessionID,
    requestID,
    state,
    delivery: mode,
    input: { prompt: { text: requestID }, settings: {} },
    createdAt: 1_700_000_000_000,
  }
}

function session(id: string, sessionTitle: string, engine: "opencode" | "codex" = "codex") {
  return {
    id,
    engine,
    projectID: "project-codex-controls",
    directory,
    title: sessionTitle,
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

function sessionHref(id: string) {
  return `/server/${base64Encode(server)}/session/${id}`
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

async function sendRefresh(
  transport: Awaited<ReturnType<typeof installSseTransport>>,
  current: LabDescribeOutput[number],
) {
  await transport.send(
    {
      id: `evt_codex_plan_${current.revision}`,
      type: "session.external.changed",
      location: { directory },
      data: {
        sessionID,
        epoch,
        revision: current.revision,
        descriptor: current,
        refresh: true,
      },
    },
    { id: `sse_codex_plan_${current.revision}` },
  )
}

function postBody(route: Route) {
  const value: unknown = JSON.parse(route.request().postData() ?? "null")
  if (!record(value)) throw new Error("Expected an object request body")
  return value
}

function replyBody(route: Route): ReplyBody {
  const value = postBody(route)
  if (typeof value.revision !== "number") throw new Error("Expected a reply revision")
  const answers = value.answers
  if (answers !== undefined && !answerRecord(answers)) {
    throw new Error("Expected string-array answers")
  }
  return {
    revision: value.revision,
    ...(typeof value.choiceID === "string" ? { choiceID: value.choiceID } : {}),
    ...(answerRecord(answers) ? { answers } : {}),
    ...(value.content === undefined ? {} : { content: value.content }),
  }
}

function queueBody(route: Route): QueueBody {
  const value = postBody(route)
  if (
    (value.action !== "resume" && value.action !== "withdraw") ||
    typeof value.requestID !== "string" ||
    typeof value.revision !== "number"
  ) {
    throw new Error("Expected a queue action")
  }
  return { action: value.action, requestID: value.requestID, revision: value.revision }
}

function answerRecord(value: unknown): value is Record<string, string[]> {
  return (
    record(value) &&
    Object.values(value).every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
