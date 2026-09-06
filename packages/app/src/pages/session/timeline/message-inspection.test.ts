import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"

type Fixture = typeof import("./message-inspection.fixture")

let fixture: Fixture
let output: string
const disposers: Array<() => void> = []

beforeAll(async () => {
  output = await mkdtemp(path.join(tmpdir(), "opencode-message-inspection-"))
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [solid()],
    worker: { format: "es" },
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: path.resolve(import.meta.dir, "message-inspection.fixture.tsx"),
        formats: ["es"],
        fileName: "fixture",
      },
    },
  })
  fixture = (await import(pathToFileURL(path.join(output, "fixture.js")).href)) as Fixture
})

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

afterAll(async () => {
  await rm(output, { recursive: true, force: true })
})

function mount(input: Parameters<Fixture["mount"]>[0]) {
  const mounted = fixture.mount(input)
  disposers.push(mounted.dispose)
  return mounted.root
}

describe("message tool inspection", () => {
  test("opens a pending tool in the inspector exactly once and keeps inline details compact", () => {
    const inspected: ToolPart[] = []
    const root = mount({
      part: fixture.tool({ name: "shell", status: "pending", output: "still running", args: { command: "sleep 1" } }),
      onInspectTool: (part) => inspected.push(part),
    })

    expect(root.querySelector('[data-component="tool-output"]')).toBeNull()
    fixture.click(root.querySelector('[data-component="tool-trigger"]')!)
    expect(inspected.map((part) => part.id)).toEqual(["part-shell"])
    expect(root.querySelector('[data-slot="collapsible-trigger"]')?.getAttribute("aria-expanded")).toBe("false")
  })

  test("opens an errored tool in the inspector while preserving its error trigger", () => {
    const inspected: ToolPart[] = []
    const root = mount({
      part: fixture.tool({ name: "shell", status: "error", error: "Error: command failed" }),
      onInspectTool: (part) => inspected.push(part),
    })

    expect(root.querySelector('[data-kind="tool-error-card"]')).not.toBeNull()
    expect(root.querySelector('[data-slot="tool-error-card-content"]')).toBeNull()
    fixture.click(root.querySelector('[data-component="tool-trigger"]')!)
    expect(inspected.map((part) => part.id)).toEqual(["part-shell"])
    expect(root.querySelector('[data-kind="tool-error-card"]')?.getAttribute("data-open")).toBe("false")
  })

  test("keeps rich inline tool details when no inspection callback is provided", () => {
    const root = mount({
      part: fixture.tool({ name: "shell", status: "completed", output: "done", args: { command: "echo done" } }),
    })

    fixture.click(root.querySelector('[data-component="tool-trigger"]')!)
    expect(root.textContent).toContain("done")
  })

  test("previews a task on plain click and leaves modified link clicks untouched", () => {
    const previews: string[] = []
    const root = mount({
      part: fixture.tool({
        name: "task",
        status: "completed",
        metadata: { sessionId: "session-child" },
        args: { description: "Inspect child", subagent_type: "explore" },
      }),
      onPreviewSession: (id) => previews.push(id),
    })
    const link = root.querySelector('a[href="/session/session-child"]')!
    const card = root.querySelector('[data-component="task-tool-card"]')!

    expect(fixture.click(card).defaultPrevented).toBe(true)
    expect(previews).toEqual(["session-child"])
    expect(link.getAttribute("aria-expanded")).toBe("false")
    expect(fixture.click(link, { metaKey: true }).defaultPrevented).toBe(false)
    expect(previews).toEqual(["session-child"])
  })

  test("previews an errored task from its nested link without firing twice", () => {
    const previews: string[] = []
    const root = mount({
      part: fixture.tool({
        name: "task",
        status: "error",
        error: "Error: child failed",
        metadata: { sessionId: "session-child" },
        args: { description: "Inspect child", subagent_type: "explore" },
      }),
      onPreviewSession: (id) => previews.push(id),
    })
    const link = root.querySelector('a[href="/session/session-child"]')!

    fixture.click(link)
    expect(previews).toEqual(["session-child"])
    fixture.click(link, { metaKey: true })
    expect(previews).toEqual(["session-child"])
  })

  test("does not redirect question tools to the inspector", () => {
    const inspected: ToolPart[] = []
    const root = mount({
      part: fixture.tool({ name: "question", status: "completed", args: { questions: [] }, output: "answered" }),
      onInspectTool: (part) => inspected.push(part),
    })

    fixture.click(root.querySelector('[data-component="tool-trigger"]')!)
    expect(inspected).toEqual([])
  })

  test("keeps the context group trigger expandable and inspects a specific item", () => {
    const inspected: ToolPart[] = []
    const mounted = fixture.mountContext(
      [fixture.tool({ name: "read", status: "completed", args: { filePath: "/project/a.ts" } })],
      (part) => inspected.push(part),
    )
    disposers.push(mounted.dispose)

    fixture.click(mounted.root.querySelector('[data-component="context-tool-group-trigger"]')!)
    expect(inspected).toEqual([])
    fixture.click(mounted.root.querySelector('[data-slot="context-tool-group-item"]')!)
    expect(inspected.map((part) => part.id)).toEqual(["part-read"])
  })
})
