import { spawn } from "node:child_process"
import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { CodexStdioTransport, CodexTransportClosedError } from "../src/transport.js"
import type { CodexServerNotification } from "../src/transport.js"
import type { ThreadReadResponse } from "../src/protocol/generated/v2/ThreadReadResponse.js"
import type { InitializeResponse } from "../src/protocol/generated/InitializeResponse.js"

describe("CodexStdioTransport", () => {
  test("routes responses, notifications, and unknown server requests", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixture/rpc-peer.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const notifications: CodexServerNotification[] = []
    const transport = new CodexStdioTransport(child, 7, (request) => {
      expect(request).toEqual({
        generation: 7,
        id: "server-request",
        method: "fixture/request",
        params: { question: 42 },
      })
      return { result: { accepted: true } }
    })
    transport.onNotification((notification) => notifications.push(notification))

    const initialized = await transport.request<"initialize", InitializeResponse>("initialize", {
      clientInfo: { name: "test", title: null, version: "0" },
      capabilities: null,
    })
    expect(initialized.codexHome).toBe("/fixture/home")
    transport.notify("initialized", undefined)
    await waitFor(() => notifications.some((notification) => notification.method === "fixture/requestResult"))
    expect(notifications).toContainEqual({
      generation: 7,
      method: "fixture/requestResult",
      params: { accepted: true },
    })
    await transport.close()
  })

  test("rejects pending requests when its generation exits", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixture/rpc-peer.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const transport = new CodexStdioTransport(child, 9)
    const pending = transport.request<"thread/read", ThreadReadResponse>("thread/read", {
      threadId: "exit",
      includeTurns: true,
    })
    await expect(pending).rejects.toBeInstanceOf(CodexTransportClosedError)
    expect(transport.pendingRequestCount).toBe(0)
    expect(transport.closed).toBe(true)
  })
})

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fixture")
    await Bun.sleep(10)
  }
}
