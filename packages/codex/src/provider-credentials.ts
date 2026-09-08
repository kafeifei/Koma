import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { CodexProviders } from "./providers"

// Native auth.command keeps provider keys out of config overrides, process
// environments and Codex shell snapshots. Only this scoped loopback endpoint
// can resolve a key from the host's existing credential store.
export function providerCredentials(source: CodexProviders.Interface) {
  const token = randomBytes(32).toString("hex")
  const routes = new Map<string, { providerID: string; baseURL: string }>()
  const server = createServer((request, response) => {
    const authorization = Buffer.from(request.headers.authorization ?? "")
    const expected = Buffer.from(`Bearer ${token}`)
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("Content-Type", "text/plain; charset=utf-8")
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      response.writeHead(401).end()
      return
    }
    const route = routes.get(request.url ?? "")
    if (request.method !== "GET" || !route) {
      response.writeHead(404).end()
      return
    }
    void source.key(route.providerID, route.baseURL).then(
      (key) => response.writeHead(key ? 200 : 403).end(key ?? ""),
      () => response.writeHead(503).end(),
    )
  })
  let starting: Promise<string> | undefined
  let closed = false

  return {
    async config(provider: CodexProviders.Provider) {
      if (closed) throw new Error("Codex provider credentials are unavailable")
      starting ??= new Promise<string>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject)
          const address = server.address()
          if (!address || typeof address === "string") return reject(new Error("Invalid credential listener"))
          resolve(`http://127.0.0.1:${address.port}`)
        })
      })
      const base = await starting
      const route = `/${createHash("sha256")
        .update(JSON.stringify([provider.id, provider.baseURL]))
        .digest("hex")}`
      routes.set(route, { providerID: provider.id, baseURL: provider.baseURL })
      return {
        name: provider.name,
        base_url: provider.baseURL,
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: false,
        auth: {
          command: process.platform === "win32" ? "curl.exe" : "/usr/bin/curl",
          args: [
            "--silent",
            "--show-error",
            "--fail",
            "--noproxy",
            "*",
            "--max-time",
            "5",
            "--header",
            `Authorization: Bearer ${token}`,
            `${base}${route}`,
          ],
          timeout_ms: 10_000,
          refresh_interval_ms: 1_000,
        },
      }
    },
    async close() {
      closed = true
      routes.clear()
      if (!starting) return
      await starting.catch(() => undefined)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
