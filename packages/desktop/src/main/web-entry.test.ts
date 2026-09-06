import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, request } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import { createConnection } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWebEntry } from "./web-entry"

const cleanup = new Set<() => Promise<unknown>>()

afterEach(async () => {
  await Promise.allSettled(
    Array.from(cleanup)
      .reverse()
      .map((dispose) => dispose()),
  )
  cleanup.clear()
})

test("serves only the web shell and safe renderer assets while proxying application APIs", async () => {
  const root = await webRoot()
  const requests: Array<{ url: string; headers: IncomingMessage["headers"] }> = []
  const backend = createServer((incoming, response) => {
    requests.push({ url: incoming.url ?? "", headers: incoming.headers })
    response.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "content-security-policy": "frame-ancestors *",
    })
    response.end(JSON.stringify({ url: incoming.url }))
  })
  const backendURL = await listen(backend)
  const gateway = createWebEntry({
    backend: async () => ({ url: backendURL, username: "opencode", password: "top-secret" }),
    root,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()

  const shell = await fetch(entry.url)
  expect(await shell.text()).toBe("web-shell")
  expect(shell.headers.get("x-frame-options")).toBe("DENY")
  expect(shell.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
  expect(shell.headers.get("referrer-policy")).toBe("no-referrer")

  expect(
    await fetch(`${entry.url}/task/local`, { headers: { accept: "text/html" } }).then((response) => response.text()),
  ).toBe("web-shell")
  const script = await fetch(`${entry.url}/assets/app.js`)
  expect(await script.text()).toBe("asset")
  expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
  expect((await fetch(`${entry.url}/module.wasm`)).headers.get("content-type")).toBe("application/wasm")
  expect(await fetch(`${entry.url}/robots.txt`).then((response) => response.text())).toBe("public")

  expect((await fetch(`${entry.url}/assets/missing.js`, { headers: { accept: "text/html" } })).status).toBe(404)
  expect((await fetch(`${entry.url}/index.html`, { headers: { accept: "text/html" } })).status).toBe(404)
  expect((await fetch(`${entry.url}/INDEX.HTML`, { headers: { accept: "text/html" } })).status).toBe(404)
  expect((await fetch(`${entry.url}/desktop.html`, { headers: { accept: "text/html" } })).status).toBe(404)

  const api = await fetch(`${entry.url}/session/list?directory=%2Ftmp`, {
    headers: {
      accept: "application/json",
      authorization: "Bearer browser-token",
      origin: entry.url,
      "sec-fetch-site": "same-origin",
      "x-pty-ticket": "ticket-value",
    },
  })
  expect(await api.json()).toEqual({ url: "/session/list?directory=%2Ftmp" })
  expect(api.headers.get("access-control-allow-origin")).toBeNull()
  expect(api.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
  expect(requests).toHaveLength(1)
  expect(requests[0]?.headers.authorization).toBe(`Basic ${Buffer.from("opencode:top-secret").toString("base64")}`)
  expect(requests[0]?.headers.origin).toBe(backendURL)
  expect(requests[0]?.headers.host).toBe(new URL(backendURL).host)
  expect(requests[0]?.headers["x-pty-ticket"]).toBe("ticket-value")
})

test("enforces the gateway host and browser origin boundary without blocking a top-level navigation", async () => {
  const root = await webRoot()
  const backend = createServer((_request, response) => response.end("backend"))
  const gateway = createWebEntry({
    backend: async () => ({ url: await listen(backend), username: null, password: null }),
    root,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()

  expect((await call(entry.url, { host: "localhost" })).status).toBe(421)
  expect(
    (
      await call(`${entry.url}/api/session`, {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      })
    ).status,
  ).toBe(403)
  const navigation = await call(`${entry.url}/task/one`, {
    accept: "text/html",
    origin: "https://attacker.example",
    "sec-fetch-dest": "document",
    "sec-fetch-site": "cross-site",
  })
  expect(navigation.status).toBe(200)
  expect(navigation.body).toBe("web-shell")
})

test("rejects traversal, malformed URLs, and absolute-form request targets", async () => {
  const root = await webRoot()
  const outside = join(root, "..", `outside-${process.pid}.txt`)
  await writeFile(outside, "outside")
  await symlink(outside, join(root, "outside.txt"))
  cleanup.add(() => rm(outside, { force: true }))
  const backend = createServer((_request, response) => response.end("backend"))
  const gateway = createWebEntry({
    backend: async () => ({ url: await listen(backend), username: null, password: null }),
    root,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()
  const port = Number(new URL(entry.url).port)
  const host = new URL(entry.url).host

  expect((await call(`${entry.url}/outside.txt`, { accept: "text/html" })).status).toBe(404)
  expect(
    (await raw(port, `GET /%2e%2e/outside.txt HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)).status,
  ).toBe(400)
  expect((await raw(port, `GET /%ff HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)).status).toBe(400)
  expect(
    (
      await raw(
        port,
        `GET /%ff HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${entry.url}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      )
    ).status,
  ).toBe(400)
  expect(
    (await raw(port, `GET http://example.com/api HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)).status,
  ).toBe(400)
  expect(await fetch(entry.url).then((response) => response.text())).toBe("web-shell")
})

test("falls back from an occupied preferred port, stops idempotently, and reopens", async () => {
  const root = await webRoot()
  const blocker = createServer()
  const blockedURL = await listen(blocker)
  let backendCalls = 0
  const backend = createServer((_request, response) => response.end("backend"))
  const backendURL = await listen(backend)
  const gateway = createWebEntry({
    backend: async () => {
      backendCalls += 1
      return { url: backendURL, username: null, password: null }
    },
    root,
    preferredPort: Number(new URL(blockedURL).port),
  })
  cleanup.add(() => gateway.stop())

  const first = await gateway.start()
  expect(first.url).not.toBe(blockedURL)
  expect(await gateway.start()).toEqual(first)
  expect(backendCalls).toBe(1)
  await Promise.all([gateway.stop(), gateway.stop()])
  const reopened = await gateway.start()
  expect(reopened).toEqual(first)
  expect(backendCalls).toBe(2)
})

test("streams SSE and closes both sides without stopping the backend", async () => {
  const root = await webRoot()
  let upstreamClosed = Promise.resolve()
  const backend = createServer((incoming, response) => {
    if (incoming.url !== "/api/event") return response.end("alive")
    upstreamClosed = new Promise<void>((resolve) => response.once("close", resolve))
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: first\n\n")
  })
  const backendURL = await listen(backend)
  const gateway = createWebEntry({
    backend: async () => ({ url: backendURL, username: null, password: null }),
    root,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()

  const first = await streamChunk(`${entry.url}/api/event`)
  expect(first.chunk).toBe("data: first\n\n")
  await gateway.stop()
  await upstreamClosed
  first.response.destroy()
  expect(await fetch(backendURL).then((response) => response.text())).toBe("alive")
})

test("terminates the downstream stream when an upstream SSE response resets", async () => {
  const root = await webRoot()
  const backend = createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: before-reset\n\n")
    setTimeout(() => response.destroy(), 10)
  })
  const backendURL = await listen(backend)
  const gateway = createWebEntry({
    backend: async () => ({ url: backendURL, username: null, password: null }),
    root,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()

  expect(await interruptedStream(`${entry.url}/api/event`)).toContain("data: before-reset")
  expect(await fetch(entry.url).then((response) => response.text())).toBe("web-shell")
})

test("tunnels WebSocket upgrades with query, protocol, auth, and rewritten origin", async () => {
  const root = await webRoot()
  let received: { url?: string; auth?: string; origin?: string; protocol?: string } = {}
  let upstreamSocket: Socket | undefined
  const backend = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  backend.on("upgrade", (incoming, socket) => {
    upstreamSocket = socket
    received = {
      url: incoming.url,
      auth: incoming.headers.authorization,
      origin: incoming.headers.origin,
      protocol: incoming.headers["sec-websocket-protocol"],
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: pty\r\n\r\n",
    )
    socket.on("data", (data) => socket.write(`echo:${data.toString()}`))
  })
  const backendURL = await listen(backend)
  const gateway = createWebEntry({
    backend: async () => ({ url: backendURL, username: "opencode", password: "socket-secret" }),
    root,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()
  const socket = await upgrade(entry.url, "/session/pty?ticket=a%2Bb")

  expect(socket.handshake).toContain("101 Switching Protocols")
  socket.socket.write("ping")
  expect(await socket.read("echo:ping")).toContain("echo:ping")
  expect(received).toEqual({
    url: "/session/pty?ticket=a%2Bb",
    auth: `Basic ${Buffer.from("opencode:socket-secret").toString("base64")}`,
    origin: backendURL,
    protocol: "pty",
  })

  socket.socket.resume()
  await gateway.stop()
  await Promise.all([
    waitFor("gateway client", () => socket.socket.destroyed),
    waitFor("backend client", () => upstreamSocket?.destroyed === true || upstreamSocket?.readableEnded === true),
  ])
  expect(socket.socket.destroyed).toBe(true)
  expect(upstreamSocket?.destroyed || upstreamSocket?.readableEnded).toBe(true)
  expect(await fetch(backendURL).then((response) => response.status)).toBe(404)
})

async function webRoot() {
  const root = await mkdtemp(join(tmpdir(), "opencode-web-entry-"))
  await mkdir(join(root, "assets"))
  await Promise.all([
    writeFile(join(root, "web.html"), "web-shell"),
    writeFile(join(root, "index.html"), "native-shell"),
    writeFile(join(root, "assets", "app.js"), "asset"),
    writeFile(join(root, "module.wasm"), Buffer.from([0, 97, 115, 109])),
    writeFile(join(root, "robots.txt"), "public"),
  ])
  await symlink(join(root, "index.html"), join(root, "desktop.html"))
  cleanup.add(() => rm(root, { recursive: true, force: true }))
  return root
}

function listen(server: Server) {
  return new Promise<string>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Expected TCP server"))
      cleanup.add(() => close(server))
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: Server) {
  server.closeAllConnections()
  return new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function call(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const target = new URL(url)
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      },
    )
    outgoing.on("error", reject)
    outgoing.end()
  })
}

function raw(port: number, payload: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1")
    const chunks: Buffer[] = []
    socket.on("connect", () => socket.write(payload))
    socket.on("data", (chunk) => chunks.push(chunk))
    socket.on("error", reject)
    socket.on("close", () => {
      const response = Buffer.concat(chunks).toString()
      resolve({
        status: Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0),
        body: response.split("\r\n\r\n")[1] ?? "",
      })
    })
  })
}

function streamChunk(url: string) {
  return new Promise<{ chunk: string; response: IncomingMessage }>((resolve, reject) => {
    const outgoing = request(url, (response) => {
      response.once("data", (chunk) => resolve({ chunk: chunk.toString(), response }))
      response.on("error", () => undefined)
    })
    outgoing.on("error", reject)
    outgoing.end()
  })
}

function interruptedStream(url: string) {
  return new Promise<string>((resolve, reject) => {
    const outgoing = request(url, (response) => {
      let body = ""
      let done = false
      response.on("data", (chunk) => {
        body += chunk.toString()
      })
      const finish = () => {
        if (done) return
        done = true
        resolve(body)
      }
      response.on("aborted", finish)
      response.on("error", finish)
      response.on("close", finish)
    })
    outgoing.on("error", reject)
    outgoing.end()
  })
}

function upgrade(url: string, path: string) {
  const target = new URL(url)
  return new Promise<{ socket: Socket; handshake: string; read: (value: string) => Promise<string> }>(
    (resolve, reject) => {
      const socket = createConnection(Number(target.port), target.hostname)
      let data = ""
      const onData = (chunk: Buffer) => {
        data += chunk.toString()
        const boundary = data.indexOf("\r\n\r\n")
        if (boundary < 0) return
        socket.off("data", onData)
        const trailing = data.slice(boundary + 4)
        resolve({
          socket,
          handshake: data.slice(0, boundary + 4),
          read: (value) => readSocket(socket, value, trailing),
        })
      }
      socket.on("connect", () =>
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\nOrigin: ${target.origin}\r\nSec-Fetch-Site: same-origin\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: pty\r\n\r\n`,
        ),
      )
      socket.on("data", onData)
      socket.on("error", reject)
    },
  )
}

function readSocket(socket: Socket, value: string, initial: string) {
  if (initial.includes(value)) return Promise.resolve(initial)
  return new Promise<string>((resolve, reject) => {
    let data = initial
    const onData = (chunk: Buffer) => {
      data += chunk.toString()
      if (!data.includes(value)) return
      socket.off("data", onData)
      resolve(data)
    }
    socket.on("data", onData)
    socket.on("error", reject)
  })
}

async function waitFor(label: string, check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${label} socket closure`)
}
