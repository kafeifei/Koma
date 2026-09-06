import { createReadStream } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { createServer } from "node:http"
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { extname, resolve, sep } from "node:path"

type Backend = {
  url: string
  username: string | null
  password: string | null
}

type WebEntryOptions = {
  backend: () => Promise<Backend>
  root: string
  preferredPort?: number
}

type RunningEntry = {
  server: Server
  url: string
  sockets: Set<Duplex>
  upstreamRequests: Set<ClientRequest>
  upstreamSockets: Set<Duplex>
}

const SECURITY_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
}

export function createWebEntry(options: WebEntryOptions) {
  let running: RunningEntry | undefined
  let starting: Promise<{ url: string }> | undefined
  let stopping: Promise<void> | undefined
  let preferredPort = validPort(options.preferredPort) ? options.preferredPort : 0

  const start = (): Promise<{ url: string }> => {
    if (stopping) return stopping.then(start)
    if (running) return Promise.resolve({ url: running.url })
    if (starting) return starting

    starting = (async () => {
      const backend = await options.backend()
      const backendURL = new URL(backend.url)
      if (!(["http:", "https:"] as string[]).includes(backendURL.protocol)) {
        throw new Error(`Unsupported web entry backend protocol: ${backendURL.protocol}`)
      }
      if (backendURL.username || backendURL.password)
        throw new Error("Web entry backend URL must not contain credentials")

      const root = await realpath(options.root)
      const shell = await safeFile(root, "/web.html")
      if (!shell) throw new Error("Web entry root does not contain web.html")
      const nativeIndex = await safeFile(root, "/index.html")
      const { request } = await import(backendURL.protocol === "https:" ? "node:https" : "node:http")
      const attempt = async (port: number) => {
        const sockets = new Set<Duplex>()
        const upstreamRequests = new Set<ClientRequest>()
        const upstreamSockets = new Set<Duplex>()
        const server = createServer()
        server.on("request", (incoming, response) => {
          void handleRequest({
            request: incoming,
            response,
            root,
            shell,
            nativeIndex,
            backend,
            backendURL,
            requestBackend: request,
            upstreamRequests,
            upstreamSockets,
            gatewayHost: `127.0.0.1:${portOf(server)}`,
          }).catch(() => {
            if (response.headersSent) return response.destroy()
            send(response, 500, "Internal Server Error")
          })
        })
        server.on("connection", (socket) => {
          sockets.add(socket)
          socket.once("close", () => sockets.delete(socket))
        })
        server.on("upgrade", (incoming, socket, head) => {
          proxyUpgrade({
            request: incoming,
            socket,
            head,
            gatewayOrigin: `http://127.0.0.1:${portOf(server)}`,
            gatewayHost: `127.0.0.1:${portOf(server)}`,
            backend,
            backendURL,
            requestBackend: request,
            upstreamRequests,
            upstreamSockets,
          })
        })
        server.on("clientError", (_error, socket) => {
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
        })
        await listen(server, port)
        return { server, sockets, upstreamRequests, upstreamSockets }
      }

      const listener = await attempt(preferredPort).catch(async (error: unknown) => {
        if (!preferredPort || !isAddressInUse(error)) throw error
        return attempt(0)
      })
      const url = `http://127.0.0.1:${portOf(listener.server)}`
      preferredPort = portOf(listener.server)
      running = { ...listener, url }
      return { url }
    })().finally(() => {
      starting = undefined
    })
    return starting
  }

  const stop = (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      if (starting) await starting.catch(() => undefined)
      const current = running
      running = undefined
      if (!current) return
      current.upstreamRequests.forEach((request) => request.destroy())
      current.upstreamSockets.forEach((socket) => socket.destroy())
      current.sockets.forEach((socket) => socket.destroy())
      await close(current.server)
    })().finally(() => {
      stopping = undefined
    })
    return stopping
  }

  return { start, stop }
}

async function handleRequest(input: {
  request: IncomingMessage
  response: ServerResponse
  root: string
  shell: string
  nativeIndex: string | undefined
  backend: Backend
  backendURL: URL
  requestBackend: typeof import("node:http").request
  upstreamRequests: Set<ClientRequest>
  upstreamSockets: Set<Duplex>
  gatewayHost: string
}) {
  const target = requestTarget(input.request)
  if (!target) return send(input.response, 400, "Bad Request")
  const gatewayOrigin = `http://${input.gatewayHost}`
  if (input.request.headers.host !== input.gatewayHost) return send(input.response, 421, "Misdirected Request")

  const navigation = isNavigation(input.request)
  if (!navigation && !sameOriginRequest(input.request, gatewayOrigin)) return send(input.response, 403, "Forbidden")

  if (input.request.method === "GET" || input.request.method === "HEAD") {
    if (target.pathname.toLowerCase() === "/index.html") return send(input.response, 404, "Not Found")
    const file = await safeFile(input.root, target.pathname)
    if (file && file === input.nativeIndex) return send(input.response, 404, "Not Found")
    if (file) return serve(input.request, input.response, file)
    if (target.pathname === "/assets" || target.pathname.startsWith("/assets/") || extname(target.pathname)) {
      return send(input.response, 404, "Not Found")
    }
    if (target.pathname === "/" || navigation) return serve(input.request, input.response, input.shell)
  }

  proxyRequest(input, target.raw)
}

function proxyRequest(
  input: {
    request: IncomingMessage
    response: ServerResponse
    backend: Backend
    backendURL: URL
    requestBackend: typeof import("node:http").request
    upstreamRequests: Set<ClientRequest>
    upstreamSockets: Set<Duplex>
  },
  target: string,
) {
  const headers = backendHeaders(input.request.headers, input.backendURL, input.backend)
  const upstream = input.requestBackend({
    protocol: input.backendURL.protocol,
    hostname: input.backendURL.hostname,
    port: input.backendURL.port,
    method: input.request.method,
    path: target,
    headers,
    agent: false,
  })
  trackUpstream(upstream, input.upstreamRequests, input.upstreamSockets)
  upstream.on("response", (response) => {
    const terminate = () => input.response.destroy()
    response.once("aborted", terminate)
    response.once("error", terminate)
    input.response.writeHead(response.statusCode ?? 502, responseHeaders(response.headers))
    response.pipe(input.response)
    input.response.once("close", () => {
      if (!response.complete) response.destroy()
    })
  })
  upstream.on("error", () => {
    if (input.response.headersSent) return input.response.destroy()
    send(input.response, 502, "Bad Gateway")
  })
  input.request.once("aborted", () => upstream.destroy())
  input.response.once("close", () => {
    if (!input.response.writableEnded) upstream.destroy()
  })
  input.request.pipe(upstream)
}

function proxyUpgrade(input: {
  request: IncomingMessage
  socket: Duplex
  head: Buffer
  gatewayOrigin: string
  gatewayHost: string
  backend: Backend
  backendURL: URL
  requestBackend: typeof import("node:http").request
  upstreamRequests: Set<ClientRequest>
  upstreamSockets: Set<Duplex>
}) {
  const target = requestTarget(input.request)
  if (
    !target ||
    input.request.headers.host !== input.gatewayHost ||
    !sameOriginRequest(input.request, input.gatewayOrigin)
  ) {
    return rejectUpgrade(input.socket, target ? 403 : 400)
  }

  const upstream = input.requestBackend({
    protocol: input.backendURL.protocol,
    hostname: input.backendURL.hostname,
    port: input.backendURL.port,
    method: input.request.method,
    path: target.raw,
    headers: backendHeaders(input.request.headers, input.backendURL, input.backend, true),
    agent: false,
  })
  trackUpstream(upstream, input.upstreamRequests, input.upstreamSockets)
  upstream.on("upgrade", (response, socket, head) => {
    input.upstreamSockets.add(socket)
    socket.once("close", () => {
      input.upstreamSockets.delete(socket)
      input.socket.destroy()
    })
    input.socket.once("close", () => socket.destroy())
    input.socket.write(
      `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n${rawHeaders(response.rawHeaders)}\r\n`,
    )
    if (head.length) input.socket.write(head)
    if (input.head.length) socket.write(input.head)
    socket.pipe(input.socket).pipe(socket)
  })
  upstream.on("response", (response) => {
    input.socket.write(
      `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}\r\n${rawHeaders(
        Object.entries(responseHeaders(response.headers)).flatMap(([key, value]) => [key, String(value)]),
      )}\r\n`,
    )
    response.pipe(input.socket)
  })
  upstream.on("error", () => rejectUpgrade(input.socket, 502))
  input.socket.once("close", () => upstream.destroy())
  upstream.end()
}

function backendHeaders(headers: IncomingHttpHeaders, backendURL: URL, backend: Backend, upgrade = false) {
  const result = { ...headers }
  const connectionHeaders = String(headers.connection ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (!upgrade) {
    ;[
      "connection",
      "keep-alive",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      ...connectionHeaders,
    ].forEach((key) => delete result[key])
  }
  delete result["proxy-authorization"]
  delete result.authorization
  result.host = backendURL.host
  if (headers.origin) result.origin = backendURL.origin
  if (backend.password !== null) {
    result.authorization = `Basic ${Buffer.from(`${backend.username ?? ""}:${backend.password}`).toString("base64")}`
  }
  return result
}

function responseHeaders(headers: IncomingHttpHeaders) {
  const result: Record<string, string | string[]> = {}
  const connectionHeaders = String(headers.connection ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  Object.entries(headers).forEach(([key, value]) => {
    if (value === undefined) return
    if (
      [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        ...connectionHeaders,
      ].includes(key) ||
      key.startsWith("access-control-")
    )
      return
    result[key] = value
  })
  return { ...result, ...SECURITY_HEADERS }
}

function sameOriginRequest(request: IncomingMessage, gatewayOrigin: string) {
  if (request.headers.origin !== undefined && request.headers.origin !== gatewayOrigin) return false
  const site = request.headers["sec-fetch-site"]?.toLowerCase()
  if (site === "cross-site") return false
  if (site === "same-site" && request.headers.origin !== gatewayOrigin) return false
  return true
}

function isNavigation(request: IncomingMessage) {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  if (request.headers["sec-fetch-dest"]?.toLowerCase() === "document") return true
  return request.headers.accept
    ?.split(",")
    .map((value) => value.split(";", 1)[0]?.trim().toLowerCase())
    .includes("text/html")
}

function requestTarget(request: IncomingMessage) {
  const raw = request.url
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\#\u0000-\u0020\u007f]/.test(raw)) return
  const rawPath = raw.split("?", 1)[0] ?? ""
  if (/%(?:2f|5c)/i.test(rawPath) || /%(?![0-9a-f]{2})/i.test(raw)) return
  const decoded = decode(rawPath)
  if (decoded === undefined) return
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return
  const url = new URL(raw, "http://gateway.invalid")
  const pathname = decode(url.pathname)
  if (pathname === undefined) return
  return { raw, pathname }
}

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

async function safeFile(root: string, pathname: string) {
  if (pathname.endsWith("/")) return
  const candidate = resolve(root, "." + pathname)
  if (candidate !== root && !candidate.startsWith(root + sep)) return
  const file = await realpath(candidate).catch(() => undefined)
  if (!file || (file !== root && !file.startsWith(root + sep))) return
  const info = await stat(file).catch(() => undefined)
  return info?.isFile() ? file : undefined
}

function serve(request: IncomingMessage, response: ServerResponse, file: string) {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": contentType(file),
  })
  if (request.method === "HEAD") return response.end()
  createReadStream(file)
    .on("error", () => response.destroy())
    .pipe(response)
}

function send(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  response.end(body)
}

function rejectUpgrade(socket: Duplex, status: number) {
  if (socket.destroyed) return
  const message = status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Bad Gateway"
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(
      message,
    )}\r\nConnection: close\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\n\r\n${message}`,
  )
}

function trackUpstream(request: ClientRequest, requests: Set<ClientRequest>, sockets: Set<Duplex>) {
  requests.add(request)
  request.once("close", () => requests.delete(request))
  request.once("socket", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
}

function rawHeaders(headers: string[]) {
  const lines: string[] = []
  for (let index = 0; index < headers.length; index += 2) {
    const key = headers[index]
    const value = headers[index + 1]
    if (!key || value === undefined || key.toLowerCase().startsWith("access-control-")) continue
    lines.push(`${key}: ${value}`)
  }
  SECURITY_HEADERS["x-frame-options"] && lines.push(`X-Frame-Options: ${SECURITY_HEADERS["x-frame-options"]}`)
  lines.push(`Referrer-Policy: ${SECURITY_HEADERS["referrer-policy"]}`)
  return lines.join("\r\n") + "\r\n"
}

function contentType(file: string) {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  }
  return types[extname(file).toLowerCase()] ?? "application/octet-stream"
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, "127.0.0.1")
  })
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function portOf(server: Server) {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Web entry is not listening on TCP")
  return address.port
}

function validPort(port: number | undefined): port is number {
  return port !== undefined && Number.isInteger(port) && port >= 0 && port <= 65_535
}

function isAddressInUse(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE"
}
