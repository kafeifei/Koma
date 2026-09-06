import { base64Encode } from "@opencode-ai/core/util/encode"
import type { LabDescribeOutput, LabSnapshotOutput } from "@opencode-ai/lab-client"
import { expect, test, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const directory = "/tmp/opencode-lab-external-timeline"
const sessionID = "ses_codex_timeline"
const title = "Codex external timeline"
const epoch = "codex-runtime-e2e"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const capabilities = {
  prompt: true,
  steer: true,
  queue: "host" as const,
  compact: false,
  images: true,
  permissions: true,
}

type EventShape = "native" | "legacy"
type ExternalData = Record<string, unknown>
type LegacyExternalEvent = {
  directory: string
  payload: {
    id: string
    type: "session.external.changed"
    properties: ExternalData
  }
}
type NativeExternalEvent = {
  id: string
  type: "session.external.changed"
  location: { directory: string }
  data: ExternalData
}
type ExternalTransportEvent = LegacyExternalEvent | NativeExternalEvent

const scenarios = [
  { name: "native V2 events", eventShape: "native", historyTurns: 320, deltaCount: 160 },
  { name: "legacy compatibility events", eventShape: "legacy", historyTurns: 4, deltaCount: 3 },
] as const

for (const scenario of scenarios) {
  test(`projects ${scenario.name} into one ordered external timeline`, async ({ page }) => {
    const historyTurns = scenario.historyTurns
    const deltaCount = scenario.deltaCount
    const history = Array.from({ length: historyTurns }, (_, index) => turn(index)).flat()
    const messageOrder = history.map((message) => message.id)
    let currentSnapshot = snapshot(1, history, messageOrder)
    let snapshotReads = 0
    let legacyMessageReads = 0

    const transport = await installSseTransport<ExternalTransportEvent>(page, { server, retry: 20 })
    await mockOpenCodeServer(page, {
      protocol: "v2",
      directory,
      project: {
        id: "project-codex-timeline",
        worktree: directory,
        vcs: "git",
        name: "codex-timeline",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        sandboxes: [],
      },
      provider: {
        all: [
          {
            id: "codex",
            name: "Codex",
            models: { "gpt-6": { id: "gpt-6", name: "GPT-6", limit: { context: 421_053 } } },
          },
        ],
        connected: ["codex"],
        default: { providerID: "codex", modelID: "gpt-6" },
      },
      sessions: [
        {
          id: sessionID,
          engine: "codex",
          projectID: "project-codex-timeline",
          directory,
          title,
          time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        },
      ],
      onMessages: () => legacyMessageReads++,
      pageMessages: () => ({ items: [] }),
    })
    await page.route("**/lab/**", async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== server) return route.fallback()
      if (url.pathname === "/lab/engines") return json(route, [])
      if (url.pathname === "/lab/sessions/describe") {
        const body = route.request().postDataJSON() as { sessionIDs: string[] }
        return json(route, body.sessionIDs.includes(sessionID) ? [currentSnapshot.descriptor] : [])
      }
      if (url.pathname === `/lab/sessions/${sessionID}`) {
        snapshotReads++
        return json(route, currentSnapshot)
      }
      return json(route, { message: `Unexpected Lab request: ${url.pathname}` }, 404)
    })
    await page.addInitScript(
      ({ server, directory, sessionID }) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
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
      { server, directory, sessionID },
    )
    await page.addInitScript(() => {
      const state = { armed: false, sawRows: false, cleared: false }
      ;(window as Window & { __externalTimelineProbe?: typeof state }).__externalTimelineProbe = state
      new MutationObserver(() => {
        const rows = document.querySelectorAll("[data-timeline-key]").length
        if (!state.armed) return
        if (rows > 0) state.sawRows = true
        if (state.sawRows && rows === 0) state.cleared = true
      }).observe(document.documentElement, { childList: true, subtree: true })
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    await transport.waitForConnection()
    await expectSessionTitle(page, title)

    const finalHistoryPartID = assistantPartID(historyTurns - 1)
    await expect(page.locator(`[data-timeline-part-id="${finalHistoryPartID}"]`)).toBeVisible()
    expect(snapshotReads).toBe(1)
    expect(legacyMessageReads).toBe(0)

    const streamUser = userMessage(historyTurns)
    const streamAssistant = assistantMessage(historyTurns, true, "Streaming start")
    await transport.send(changed(scenario.eventShape, 2, [streamUser, streamAssistant], descriptor(2, "active")), {
      id: "sse_external_0001",
    })

    const stream = page.locator(`[data-timeline-part-id="${assistantPartID(historyTurns)}"]`)
    const streamBody = stream.locator('[data-slot="text-part-body"]')
    await expect(stream).toHaveCount(1)
    await expect(stream).toContainText("Streaming start")
    expect(legacyMessageReads).toBe(0)

    const deltas = Array.from({ length: deltaCount }, (_, index) => `|delta-${String(index).padStart(3, "0")}|`)
    await transport.send(append(scenario.eventShape, historyTurns, 3, deltas[0]!), { id: "sse_external_0002" })
    await expect(stream).toContainText(`Streaming start${deltas[0]}`)
    await transport.burst(
      deltas.slice(1).map((delta, index) => append(scenario.eventShape, historyTurns, index + 4, delta)),
      deltas.slice(1).map((_, index) => ({ id: `sse_external_${String(index + 3).padStart(4, "0")}` })),
    )

    const finalText = `Streaming start${deltas.join("")}`
    await expect(streamBody).toHaveText(finalText)
    await expect(stream).toHaveCount(1)
    expect(legacyMessageReads).toBe(0)

    await page.evaluate(() => {
      const state = (window as Window & { __externalTimelineProbe?: { armed: boolean; sawRows: boolean } })
        .__externalTimelineProbe!
      state.sawRows = document.querySelectorAll("[data-timeline-key]").length > 0
      state.armed = true
    })
    const completedAssistant = assistantMessage(historyTurns, false, finalText)
    const completedMessages = [...history, streamUser, completedAssistant]
    const completedRevision = deltaCount + 3
    currentSnapshot = snapshot(
      completedRevision,
      completedMessages,
      completedMessages.map((message) => message.id),
    )
    await transport.send(
      changed(scenario.eventShape, completedRevision, undefined, descriptor(completedRevision, "idle"), true),
      { id: `sse_external_${String(deltaCount + 2).padStart(4, "0")}` },
    )
    await expect.poll(() => snapshotReads).toBe(2)
    await expect(streamBody).toHaveText(finalText)
    expect(
      await page.evaluate(
        () => (window as Window & { __externalTimelineProbe?: { cleared: boolean } }).__externalTimelineProbe!.cleared,
      ),
    ).toBe(false)

    const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    await scroller.evaluate((element) => {
      element.scrollTop = 0
    })
    const firstUser = page.locator(`[data-timeline-part-id="${userMessageID(0)}:text"]`)
    await expect(firstUser).toBeVisible()
    expect(legacyMessageReads).toBe(0)

    const acknowledgements = await transport.acknowledgements()
    expect(acknowledgements).toHaveLength(deltaCount + 2)
    expect(new Set(acknowledgements.map((item) => item.eventID)).size).toBe(deltaCount + 2)

    await page.getByRole("button", { name: "View context usage", exact: true }).click()
    await expect(page.getByText("Total Cost", { exact: true }).locator("..")).toContainText("—")
    await expect(page.getByText("Input Tokens", { exact: true }).locator("..")).toContainText("50,000")
    await expect(page.getByText("Usage", { exact: true }).locator("..")).toContainText("14%")
    await expect(page.getByText("Context Limit", { exact: true }).locator("..")).toContainText("421,053")
    expect(legacyMessageReads).toBe(0)

    await page.getByRole("button", { name: "View context usage", exact: true }).click()
    await page.getByRole("button", { name: "Toggle review", exact: true }).click()
    await page.getByRole("button", { name: "Git changes", exact: true }).click()
    await page.getByText("Last turn changes", { exact: true }).click()
    await expect(page.getByText("Codex did not provide a diff for this turn.", { exact: true })).toBeVisible()

    currentSnapshot = {
      ...currentSnapshot,
      descriptor: descriptor(completedRevision + 1),
      turnDiffs: {
        [`turn-${historyTurns}`]: {
          status: "available",
          value: [
            {
              file: "native-proof.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch:
                "diff --git a/native-proof.ts b/native-proof.ts\n--- a/native-proof.ts\n+++ b/native-proof.ts\n@@ -1 +1,2 @@\n existing\n+native change\n",
            },
          ],
        },
      },
    }
    await transport.send(
      changed(scenario.eventShape, completedRevision + 1, undefined, currentSnapshot.descriptor, true),
      {
        id: `sse_external_${String(deltaCount + 3).padStart(4, "0")}`,
      },
    )
    await expect(page.getByRole("button", { name: "native-proof.ts", exact: true })).toBeVisible()
    await expect(page.getByText("Codex did not provide a diff for this turn.", { exact: true })).toHaveCount(0)
    expect(legacyMessageReads).toBe(0)
  })
}

function descriptor(revision: number, runtimeStatus: "idle" | "active" = "idle"): LabDescribeOutput[number] {
  return {
    sessionID,
    engine: "codex",
    epoch,
    revision,
    runtimeStatus,
    bindingState: "bound",
    capabilities,
    queuePaused: false,
    settings: { model: "gpt-6", effort: "high", permission: "workspace" },
  }
}

function snapshot(
  revision: number,
  messages: LabSnapshotOutput["messages"],
  order: readonly string[],
): LabSnapshotOutput {
  return {
    descriptor: descriptor(revision),
    messages,
    messageOrder: order,
    partOrder: Object.fromEntries(
      messages.flatMap((message) =>
        message.type === "assistant" ? [[message.id, message.content.map((part) => part.id)]] : [],
      ),
    ),
    interactions: [],
    deliveries: [],
    usage: {
      status: "available",
      value: { input: 50_000, output: 8_000, reasoning: 2_000, cache: { read: 4_000, write: 0 }, total: 64_000 },
    },
    contextTokens: { status: "available", value: 60_000 },
    contextWindow: { status: "available", value: 421_053 },
    cost: { status: "unavailable" },
    turnDiffs: {},
    sessionDiff: { status: "unavailable" },
    children: [],
  }
}

function turn(index: number): LabSnapshotOutput["messages"] {
  return [userMessage(index), assistantMessage(index, false, `History assistant ${String(index).padStart(3, "0")}`)]
}

function userMessage(index: number): Extract<LabSnapshotOutput["messages"][number], { type: "user" }> {
  return {
    id: userMessageID(index),
    type: "user",
    text: `History user ${String(index).padStart(3, "0")}`,
    metadata: { codex: { turnID: `turn-${index}` } },
    orderKey: `codex_order_identity_${String(10_000 - index * 2).padStart(5, "0")}`,
    time: { created: 1_700_000_000_000 + index * 2_000 },
  }
}

function assistantMessage(
  index: number,
  streaming: boolean,
  text: string,
): Extract<LabSnapshotOutput["messages"][number], { type: "assistant" }> {
  return {
    id: assistantMessageID(index),
    type: "assistant",
    orderKey: `codex_order_identity_${String(9_999 - index * 2).padStart(5, "0")}`,
    time: { created: 1_700_000_001_000 + index * 2_000 },
    streaming,
    agent: "codex",
    model: { providerID: "codex", id: "gpt-6" },
    content: [{ id: assistantPartID(index), type: "text", text }],
  }
}

function userMessageID(index: number) {
  return `msg_codex_native_z_${String(9_999 - index).padStart(4, "0")}_user`
}

function assistantMessageID(index: number) {
  return `msg_codex_native_a_${String(index).padStart(4, "0")}_assistant`
}

function assistantPartID(index: number) {
  return `prt_codex_${String(index).padStart(4, "0")}_text`
}

function changed(
  eventShape: EventShape,
  revision: number,
  messages?: LabSnapshotOutput["messages"],
  currentDescriptor?: LabDescribeOutput[number],
  refresh?: boolean,
): ExternalTransportEvent {
  return externalEvent(eventShape, revision, {
    sessionID,
    epoch,
    revision,
    messages,
    descriptor: currentDescriptor,
    refresh,
    activityAt: 1_700_000_000_000 + revision,
  })
}

function append(eventShape: EventShape, messageIndex: number, revision: number, delta: string) {
  return externalEvent(eventShape, revision, {
    sessionID,
    epoch,
    revision,
    append: {
      messageID: assistantMessageID(messageIndex),
      partID: assistantPartID(messageIndex),
      type: "text",
      delta,
    },
  })
}

function externalEvent(eventShape: EventShape, revision: number, data: ExternalData): ExternalTransportEvent {
  const id = `evt_external_${revision}`
  if (eventShape === "native") {
    return {
      id,
      type: "session.external.changed",
      location: { directory },
      data,
    }
  }
  return {
    directory,
    payload: {
      id,
      type: "session.external.changed",
      properties: data,
    },
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
