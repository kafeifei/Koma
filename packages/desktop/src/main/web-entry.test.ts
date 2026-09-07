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

test("allows only the confirmed remote origin and revokes it without reopening the local listener", async () => {
  const root = await webRoot()
  const requests: IncomingMessage["headers"][] = []
  const backend = createServer((incoming, response) => {
    requests.push(incoming.headers)
    response.end("backend")
  })
  const backendURL = await listen(backend)
  const relay = { origin: undefined as string | undefined }
  const gateway = createWebEntry({
    backend: async () => ({ url: backendURL, username: "opencode", password: "local-secret" }),
    root,
    remoteOrigin: () => relay.origin,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()
  const host = "device-4321.example.devtunnels.ms"
  const headers = { host, origin: `https://${host}`, "sec-fetch-site": "same-origin" }
  expect((await call(`${entry.url}/session`, headers)).status).toBe(421)
  relay.origin = headers.origin
  expect((await call(`${entry.url}/session`, { ...headers, "x-tunnel-authorization": "tunnel secret" })).body).toBe(
    "backend",
  )
  expect(requests).toHaveLength(1)
  expect(requests[0]?.["x-tunnel-authorization"]).toBeUndefined()
  expect(requests[0]?.authorization).toBe(`Basic ${Buffer.from("opencode:local-secret").toString("base64")}`)
  expect(requests[0]?.origin).toBe(backendURL)
  expect((await call(`${entry.url}/session`, { ...headers, origin: "https://other.devtunnels.ms" })).status).toBe(403)
  expect((await call(`${entry.url}/session`, { ...headers, host: "other.devtunnels.ms" })).status).toBe(421)
  expect((await call(`${entry.url}/session`, { ...headers, origin: "http://localhost" })).status).toBe(403)
  expect((await call(`${entry.url}/session`, { ...headers, origin: entry.url })).status).toBe(403)
  expect((await call(`${entry.url}/session`, { ...headers, "sec-fetch-site": "cross-site" })).status).toBe(403)
  expect(
    (
      await raw(
        Number(new URL(entry.url).port),
        `GET /pty HTTP/1.1\r\nHost: ${host}\r\nOrigin: https://other.devtunnels.ms\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      )
    ).status,
  ).toBe(403)
  relay.origin = undefined
  expect((await call(`${entry.url}/session`, headers)).status).toBe(421)
  expect(await fetch(entry.url).then((response) => response.text())).toBe("web-shell")
  expect(requests).toHaveLength(1)
})

test("rejects malformed, insecure, or non-origin relay addresses", async () => {
  const root = await webRoot()
  const backend = createServer((_request, response) => response.end("backend"))
  const relay = { origin: "" }
  const gateway = createWebEntry({
    backend: async () => ({ url: await listen(backend), username: null, password: null }),
    root,
    remoteOrigin: () => relay.origin,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()
  for (const origin of [
    "invalid",
    "http://relay.example",
    "https://user:secret@relay.example",
    "https://relay.example/path",
    "https://relay.example?token=secret",
  ]) {
    relay.origin = origin
    expect((await call(`${entry.url}/session`, { host: "relay.example" })).status).toBe(421)
  }
})

test("exposes CORS and WebSockets only to the configured renderer origin", async () => {
  const root = await webRoot()
  const requests: IncomingMessage["headers"][] = []
  const backend = createServer((incoming, response) => {
    requests.push(incoming.headers)
    response.writeHead(200, { "access-control-allow-origin": "*" })
    response.end("backend")
  })
  backend.on("upgrade", (incoming, socket) => {
    requests.push(incoming.headers)
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
  })
  const backendURL = await listen(backend)
  const gateway = createWebEntry({
    backend: async () => ({ url: backendURL, username: null, password: null }),
    clientOrigin: "oc://renderer",
    root,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()

  const preflight = await fetch(`${entry.url}/session`, {
    method: "OPTIONS",
    headers: {
      origin: "oc://renderer",
      "access-control-request-method": "POST",
      "access-control-request-headers": "Content-Type, X-Client-Version, Authorization, X-Tunnel-Authorization",
    },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-origin")).toBe("oc://renderer")
  expect(preflight.headers.get("access-control-allow-methods")).toBe("POST")
  expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type, x-client-version")
  expect(requests).toHaveLength(0)

  const api = await fetch(`${entry.url}/session`, {
    headers: {
      origin: "oc://renderer",
      "sec-fetch-site": "cross-site",
      "x-tunnel-authorization": "must-not-forward",
    },
  })
  expect(await api.text()).toBe("backend")
  expect(api.headers.get("access-control-allow-origin")).toBe("oc://renderer")
  expect(requests[0]?.["x-tunnel-authorization"]).toBeUndefined()

  const socket = await upgrade(entry.url, "/session/pty", undefined, "oc://renderer")
  expect(socket.handshake).toContain("101 Switching Protocols")
  expect(requests[1]?.origin).toBe(backendURL)
  socket.socket.destroy()

  const attacker = await fetch(`${entry.url}/session`, {
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  })
  expect(attacker.status).toBe(403)
  expect(attacker.headers.get("access-control-allow-origin")).toBeNull()
  const attackerPreflight = await fetch(`${entry.url}/session`, {
    method: "OPTIONS",
    headers: { origin: "https://attacker.example", "access-control-request-method": "POST" },
  })
  expect(attackerPreflight.status).toBe(403)
  expect(attackerPreflight.headers.get("access-control-allow-origin")).toBeNull()
  expect(requests).toHaveLength(2)
})

test("uses the injected relay stream or fails closed before transport fallback", async () => {
  const root = await webRoot()
  const requests: IncomingMessage["headers"][] = []
  const backend = createServer((incoming, response) => {
    requests.push(incoming.headers)
    response.setHeader("x-tunnel-authorization", "must-not-return")
    response.end("relayed")
  })
  backend.on("upgrade", (incoming, socket) => {
    requests.push(incoming.headers)
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Tunnel-Authorization: must-not-return\r\n\r\n",
    )
  })
  const backendURL = new URL(await listen(backend))
  let fallbackRequests = 0
  const fallback = createServer((_incoming, response) => {
    fallbackRequests += 1
    response.end("public fallback")
  })
  const fallbackURL = new URL(await listen(fallback))
  const fallbackHost = `localhost:${fallbackURL.port}`
  const publicOrigin = `https://${fallbackHost}`
  let connections = 0
  const gateway = createWebEntry({
    backend: async () => ({
      url: `http://${fallbackHost}`,
      origin: publicOrigin,
      username: null,
      password: null,
      connect: async () => {
        connections += 1
        return createConnection(Number(backendURL.port), backendURL.hostname)
      },
    }),
    clientOrigin: "oc://renderer",
    root,
  })
  cleanup.add(() => gateway.stop())
  const entry = await gateway.start()

  const api = await fetch(`${entry.url}/session`, {
    headers: {
      origin: "oc://renderer",
      "sec-fetch-site": "cross-site",
      "x-tunnel-authorization": "must-not-forward",
    },
  })
  const apiBody = await api.text()
  if (process.versions.bun === "1.3.14") {
    // Bun 1.3 ignores an Agent's asynchronous createConnection override. The
    // rejected lookup proves that it fails closed instead of dialing the public host.
    expect(api.status).toBe(502)
    expect(apiBody).toBe("Bad Gateway")
    expect(requests).toHaveLength(0)
    expect(connections).toBe(0)
  }
  if (process.versions.bun !== "1.3.14") {
    expect(apiBody).toBe("relayed")
    expect(api.headers.get("x-tunnel-authorization")).toBeNull()
    expect(requests[0]?.host).toBe(new URL(publicOrigin).host)
    expect(requests[0]?.origin).toBe(publicOrigin)
    expect(requests[0]?.["x-tunnel-authorization"]).toBeUndefined()

    const socket = await upgrade(entry.url, "/session/pty", undefined, "oc://renderer")
    expect(socket.handshake).toContain("101 Switching Protocols")
    expect(socket.handshake.toLowerCase()).not.toContain("x-tunnel-authorization")
    expect(requests[1]?.host).toBe(new URL(publicOrigin).host)
    expect(requests[1]?.origin).toBe(publicOrigin)
    expect(connections).toBe(2)
    socket.socket.destroy()
  }
  expect(fallbackRequests).toBe(0)

  const unavailable = createWebEntry({
    backend: async () => ({
      url: `http://${fallbackHost}`,
      origin: publicOrigin,
      username: null,
      password: null,
      connect: async () => {
        throw new Error("relay unavailable")
      },
    }),
    root,
  })
  cleanup.add(() => unavailable.stop())
  expect(await fetch((await unavailable.start()).url + "/session").then((response) => response.status)).toBe(502)
  expect(fallbackRequests).toBe(0)
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

test.each([undefined, "https://device-4321.example.devtunnels.ms"])(
  "tunnels WebSocket upgrades with query, protocol, auth, and rewritten origin (%s)",
  async (remoteOrigin) => {
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
      remoteOrigin: () => remoteOrigin,
    })
    cleanup.add(() => gateway.stop())
    const entry = await gateway.start()
    const socket = await upgrade(entry.url, "/session/pty?ticket=a%2Bb", remoteOrigin)

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
  },
)

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

function upgrade(url: string, path: string, remoteOrigin?: string, requestOrigin?: string) {
  const target = new URL(url)
  const publicURL = new URL(remoteOrigin ?? url)
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
          `GET ${path} HTTP/1.1\r\nHost: ${publicURL.host}\r\nOrigin: ${requestOrigin ?? publicURL.origin}\r\nSec-Fetch-Site: same-origin\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: pty\r\n\r\n`,
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
