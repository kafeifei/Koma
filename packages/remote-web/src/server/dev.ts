import http from "node:http"
import { createServer } from "vite"
import { handleNodeRequest } from "./node.ts"

const server = http.createServer()
const vite = await createServer({
  appType: "spa",
  server: { middlewareMode: true, hmr: { server } },
})

server.on("request", (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  if (pathname.startsWith("/api/")) {
    const address = server.address()
    if (!address || typeof address === "string") {
      response.writeHead(503).end()
      return
    }
    void handleNodeRequest(request, response, {
      ...process.env,
      REMOTE_WEB_ORIGIN: `http://127.0.0.1:${address.port}`,
    })
    return
  }
  vite.middlewares(request, response)
})

await new Promise<void>((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})

const address = server.address()
if (!address || typeof address === "string") throw new Error("Remote Web development server did not bind a TCP port")
const origin = `http://127.0.0.1:${address.port}`
console.log(`Koma Remote: ${origin}`)
if (!process.env.SESSION_SECRET) console.log("SESSION_SECRET is not configured; authentication endpoints are disabled.")

const close = () => {
  void vite.close()
  server.close()
}
process.once("SIGINT", close)
process.once("SIGTERM", close)
