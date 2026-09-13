import { createReadStream } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { Agent, createServer } from "node:http"
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http"
import type { LookupFunction } from "node:net"
import type { Duplex } from "node:stream"
import { extname, resolve, sep } from "node:path"

type Backend = {
  url: string
  username: string | null
  password: string | null
  origin?: string
  connect?: () => Promise<Duplex>
}

type WebEntryOptions = {
  backend: () => Promise<Backend>
  root: string
  preferredPort?: number
  clientOrigin?: string
  // Supplied only by a private, authenticated relay host after its endpoint is confirmed.
  // The relay must preserve both Host and Origin; this is an origin check, not authentication.
  remoteOrigin?: () => string | undefined
}

type RunningEntry = {
  server: Server
  url: string
  sockets: Set<Duplex>
  upstreamRequests: Set<ClientRequest>
  upstreamSockets: Set<Duplex>
  backendAgent: Agent | false
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
      const backendOrigin = backend.origin === undefined ? undefined : canonicalHTTPSOrigin(backend.origin)
      if (backend.origin !== undefined && !backendOrigin) throw new Error("Invalid web entry backend origin")
      if (
        (backend.connect === undefined) !== (backendOrigin === undefined) ||
        (backend.connect && backendURL.protocol !== "http:")
      ) {
        throw new Error("Web entry relay backend requires an HTTP URL, HTTPS origin, and private connection")
      }
      const clientOrigin = options.clientOrigin === undefined ? undefined : canonicalClientOrigin(options.clientOrigin)
      if (options.clientOrigin !== undefined && !clientOrigin) throw new Error("Invalid web entry client origin")

      const root = await realpath(options.root)
      const shell = await safeFile(root, "/web.html")
      if (!shell) throw new Error("Web entry root does not contain web.html")
      const nativeIndex = await safeFile(root, "/index.html")
      const { request } = await import(backendURL.protocol === "https:" ? "node:https" : "node:http")
      const backendAgent = privateAgent(backend)
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
            backendAgent,
            upstreamRequests,
            upstreamSockets,
            gatewayHost: `127.0.0.1:${portOf(server)}`,
            remoteOrigin: options.remoteOrigin?.(),
            clientOrigin,
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
            gatewayHost: `127.0.0.1:${portOf(server)}`,
            remoteOrigin: options.remoteOrigin?.(),
            clientOrigin,
            backend,
            backendURL,
            requestBackend: request,
            backendAgent,
            upstreamRequests,
            upstreamSockets,
          })
        })
        server.on("clientError", (_error, socket) => {
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
        })
        await listen(server, port)
        return { server, sockets, upstreamRequests, upstreamSockets, backendAgent }
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
      current.backendAgent && current.backendAgent.destroy()
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
  backendAgent: Agent | false
  upstreamRequests: Set<ClientRequest>
  upstreamSockets: Set<Duplex>
  gatewayHost: string
  remoteOrigin?: string
  clientOrigin?: string
}) {
  const target = requestTarget(input.request)
  if (!target) return send(input.response, 400, "Bad Request")
  const gatewayOrigin = acceptedOrigin(input.request, input.gatewayHost, input.remoteOrigin)
  if (!gatewayOrigin) return send(input.response, 421, "Misdirected Request")
  const clientOrigin = input.request.headers.origin === input.clientOrigin ? input.clientOrigin : undefined

  if (isPreflight(input.request)) {
    if (!clientOrigin) return send(input.response, 403, "Forbidden")
    return preflight(input.request, input.response, clientOrigin)
  }

  const navigation = isNavigation(input.request)
  if (!navigation && !sameOriginRequest(input.request, gatewayOrigin, input.clientOrigin)) {
    return send(input.response, 403, "Forbidden")
  }

  if (input.request.method === "GET" || input.request.method === "HEAD") {
    if (target.pathname.toLowerCase() === "/index.html") return send(input.response, 404, "Not Found", clientOrigin)
    const file = await safeFile(input.root, target.pathname)
    if (file && file === input.nativeIndex) return send(input.response, 404, "Not Found", clientOrigin)
    if (file) return serve(input.request, input.response, file, clientOrigin)
    if (target.pathname === "/assets" || target.pathname.startsWith("/assets/") || extname(target.pathname)) {
      return send(input.response, 404, "Not Found", clientOrigin)
    }
    if (target.pathname === "/" || navigation) return serve(input.request, input.response, input.shell, clientOrigin)
  }

  proxyRequest({ ...input, clientOrigin }, target.raw)
}

function proxyRequest(
  input: {
    request: IncomingMessage
    response: ServerResponse
    backend: Backend
    backendURL: URL
    requestBackend: typeof import("node:http").request
    backendAgent: Agent | false
    upstreamRequests: Set<ClientRequest>
    upstreamSockets: Set<Duplex>
    clientOrigin?: string
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
    agent: input.backendAgent,
    lookup: input.backend.connect ? rejectPublicLookup : undefined,
  })
  trackUpstream(upstream, input.upstreamRequests, input.upstreamSockets)
  upstream.on("response", (response) => {
    const terminate = () => input.response.destroy()
    response.once("aborted", terminate)
    response.once("error", terminate)
    input.response.writeHead(response.statusCode ?? 502, responseHeaders(response.headers, input.clientOrigin))
    response.pipe(input.response)
    input.response.once("close", () => {
      if (!response.complete) response.destroy()
    })
  })
  upstream.on("error", () => {
    if (input.response.headersSent) return input.response.destroy()
    send(input.response, 502, "Bad Gateway", input.clientOrigin)
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
  gatewayHost: string
  remoteOrigin?: string
  clientOrigin?: string
  backend: Backend
  backendURL: URL
  requestBackend: typeof import("node:http").request
  backendAgent: Agent | false
  upstreamRequests: Set<ClientRequest>
  upstreamSockets: Set<Duplex>
}) {
  const target = requestTarget(input.request)
  const origin = acceptedOrigin(input.request, input.gatewayHost, input.remoteOrigin)
  if (!target || !origin || !sameOriginRequest(input.request, origin, input.clientOrigin)) {
    return rejectUpgrade(input.socket, target ? 403 : 400)
  }

  const upstream = input.requestBackend({
    protocol: input.backendURL.protocol,
    hostname: input.backendURL.hostname,
    port: input.backendURL.port,
    method: input.request.method,
    path: target.raw,
    headers: backendHeaders(input.request.headers, input.backendURL, input.backend, true),
    agent: input.backendAgent,
    lookup: input.backend.connect ? rejectPublicLookup : undefined,
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
  delete result["x-tunnel-authorization"]
  delete result.authorization
  result.host = backendURL.host
  if (headers.origin) result.origin = backend.origin ?? backendURL.origin
  // The client gateway has already checked the browser origin. Fetch Metadata
  // describes that browser-to-loopback hop, not the private relay request with
  // its rewritten Host and Origin. Keeping "cross-site" rejects valid requests
  // at the remote gateway, including event streams and WebSocket upgrades.
  if (backend.connect) {
    for (const key of Object.keys(result)) if (key.startsWith("sec-fetch-")) delete result[key]
  }
  if (backend.password !== null) {
    result.authorization = `Basic ${Buffer.from(`${backend.username ?? ""}:${backend.password}`).toString("base64")}`
  }
  return result
}

function responseHeaders(headers: IncomingHttpHeaders, clientOrigin?: string) {
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
        "x-tunnel-authorization",
        ...connectionHeaders,
      ].includes(key) ||
      key.startsWith("access-control-")
    )
      return
    result[key] = value
  })
  return { ...result, ...SECURITY_HEADERS, ...corsHeaders(clientOrigin) }
}

function acceptedOrigin(request: IncomingMessage, gatewayHost: string, remoteOrigin?: string) {
  if (request.headers.host === gatewayHost) return `http://${gatewayHost}`
  if (!remoteOrigin || !URL.canParse(remoteOrigin)) return
  const remote = new URL(remoteOrigin)
  if (remote.protocol !== "https:" || remote.origin !== remoteOrigin) return
  if (request.headers.host === remote.host) return remote.origin
}

function sameOriginRequest(request: IncomingMessage, gatewayOrigin: string, clientOrigin?: string) {
  if (clientOrigin && request.headers.origin === clientOrigin) return true
  if (request.headers.origin !== undefined && request.headers.origin !== gatewayOrigin) return false
  const site = request.headers["sec-fetch-site"]?.toLowerCase()
  if (site === "cross-site") return false
  if (site === "same-site" && request.headers.origin !== gatewayOrigin) return false
  return true
}

function isPreflight(request: IncomingMessage) {
  return request.method === "OPTIONS" && request.headers["access-control-request-method"] !== undefined
}

function preflight(request: IncomingMessage, response: ServerResponse, origin: string) {
  const method = request.headers["access-control-request-method"]
  if (typeof method !== "string" || !["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"].includes(method)) {
    return send(response, 400, "Bad Request", origin)
  }
  const requested = request.headers["access-control-request-headers"]
  const headers = (Array.isArray(requested) ? requested.join(",") : (requested ?? ""))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (headers.some((value) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(value))) {
    return send(response, 400, "Bad Request", origin)
  }
  const allowed = [...new Set(headers.filter((value) => !SENSITIVE_REQUEST_HEADERS.has(value)))]
  response.writeHead(204, {
    ...SECURITY_HEADERS,
    ...corsHeaders(origin),
    "access-control-allow-methods": method,
    ...(allowed.length ? { "access-control-allow-headers": allowed.join(", ") } : {}),
    vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  })
  response.end()
}

const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "x-tunnel-authorization",
])

function corsHeaders(origin?: string) {
  return origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}
}

function privateAgent(backend: Backend): Agent | false {
  const connect = backend.connect
  if (!connect) return false
  const agent = new Agent({ keepAlive: false })
  agent.createConnection = (_options, connected) => {
    if (!connected) throw new Error("Private connection requires an asynchronous callback")
    void connect().then(
      (socket) => connected(null, socket),
      (error: unknown) =>
        connected(error instanceof Error ? error : new Error("Relay connection failed"), undefined as never),
    )
    return undefined
  }
  return agent
}

const rejectPublicLookup: LookupFunction = (_hostname, _options, callback) => {
  // If a runtime ignores the custom Agent, it must still fail before resolving the public relay host.
  callback(new Error("Private relay connection required"), undefined as never, undefined as never)
}

function canonicalHTTPSOrigin(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol === "https:" && url.origin === value && !url.username && !url.password) return value
}

function canonicalClientOrigin(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) return
  if (url.protocol === "http:" || url.protocol === "https:") return url.origin === value ? value : undefined
  if (url.href === value && url.host && !url.pathname) return value
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

function serve(request: IncomingMessage, response: ServerResponse, file: string, clientOrigin?: string) {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    ...corsHeaders(clientOrigin),
    "content-type": contentType(file),
  })
  if (request.method === "HEAD") return response.end()
  createReadStream(file)
    .on("error", () => response.destroy())
    .pipe(response)
}

function send(response: ServerResponse, status: number, body: string, clientOrigin?: string) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...corsHeaders(clientOrigin),
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
    if (
      !key ||
      value === undefined ||
      key.toLowerCase().startsWith("access-control-") ||
      key.toLowerCase() === "x-tunnel-authorization"
    )
      continue
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
