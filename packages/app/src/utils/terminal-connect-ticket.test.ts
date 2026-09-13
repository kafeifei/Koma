import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { terminalConnectTicket } from "./terminal-connect-ticket"

const messages = {
  csrf: () => "Ticket rejected",
  status: (status: number) => `Ticket failed (${status})`,
  network: () => "Terminal disconnected",
}

test("preserves the SDK transport error when shutdown leaves no HTTP response", async () => {
  const client = createOpencodeClient({
    baseUrl: "http://127.0.0.1:1",
    fetch: Object.assign(
      async () => {
        throw new Error("Backend stopped")
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const result = await client.pty.connectToken({ ptyID: "pty_shutdown" }, { throwOnError: false })
  expect(result.response).toBeUndefined()
  expect(() => terminalConnectTicket(result, messages)).toThrow("Backend stopped")
})

test("preserves aborted ticket requests instead of reading an absent response", async () => {
  const abort = new AbortController()
  const client = createOpencodeClient({
    baseUrl: "http://127.0.0.1:1",
    fetch: (async (request) => {
      const signal = (request as Request).signal
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
    }) as typeof fetch,
  })
  const pending = client.pty.connectToken({ ptyID: "pty_shutdown" }, { throwOnError: false, signal: abort.signal })
  await Bun.sleep(0)
  abort.abort()
  const result = await pending
  expect(result.response).toBeUndefined()
  expect(() => terminalConnectTicket(result, messages)).toThrow()
  expect(() => terminalConnectTicket(result, messages)).not.toThrow("reading 'status'")
})

test("keeps successful tickets, unsupported endpoint fallback and HTTP errors distinct", () => {
  expect(terminalConnectTicket({ response: new Response(), data: { ticket: "ticket" } }, messages)).toBe("ticket")
  for (const status of [404, 405]) {
    expect(terminalConnectTicket({ response: new Response(null, { status }) }, messages)).toBeUndefined()
  }
  expect(() => terminalConnectTicket({ response: new Response(null, { status: 403 }) }, messages)).toThrow(
    "Ticket rejected",
  )
  expect(() => terminalConnectTicket({ response: new Response(null, { status: 503 }) }, messages)).toThrow("503")
  expect(() => terminalConnectTicket({}, messages)).toThrow("Terminal disconnected")
})
