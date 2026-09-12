import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"

export type WriterHandoff = Awaited<ReturnType<typeof writerHandoff>>

/** Private, authenticated control between hosts sharing one native home. */
export async function writerHandoff(input: {
  home: string
  owns: (threadID: string) => boolean
  release: (threadID: string) => Promise<void>
}) {
  const directory = path.join(input.home, "koma-hosts")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const file = path.join(directory, `${token}.json`)
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, {})
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const threadID = url.searchParams.get("threadID")
    if (!threadID || threadID.length > 200) return send(400, {})
    if (request.method === "GET" && url.pathname === "/owner") return send(200, { owns: input.owns(threadID) })
    if (request.method !== "POST" || url.pathname !== "/release") return send(404, {})
    if (!input.owns(threadID)) return send(409, { error: "The native writer changed before handoff" })
    try {
      await input.release(threadID)
      send(200, { released: true })
    } catch (error) {
      send(409, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  server.requestTimeout = 35_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Native handoff endpoint did not start")
  const url = `http://127.0.0.1:${address.port}`
  try {
    await writeFile(file, JSON.stringify({ url, token }), { flag: "wx", mode: 0o600 })
  } catch (error) {
    server.close()
    throw error
  }
  server.unref()
  async function peers() {
    const result: Array<{ url: string; token: string }> = []
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]+\.json$/.test(name) || name === path.basename(file)) continue
      const peer = await readFile(path.join(directory, name), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => undefined)
      if (!peer || typeof peer.url !== "string" || typeof peer.token !== "string") continue
      if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(peer.url)) continue
      result.push(peer)
    }
    return result
  }
  return {
    async hasPeers() {
      for (const peer of await peers()) {
        const reachable = await fetch(`${peer.url}/owner?threadID=probe`, {
          headers: { Authorization: `Bearer ${peer.token}` },
          signal: AbortSignal.timeout(1000),
        }).then(
          (response) => response.ok,
          () => false,
        )
        if (reachable) return true
      }
      return false
    },
    async release(threadID: string) {
      for (const peer of await peers()) {
        const headers = { Authorization: `Bearer ${peer.token}` }
        const query = `?threadID=${encodeURIComponent(threadID)}`
        const owner = await fetch(`${peer.url}/owner${query}`, { headers, signal: AbortSignal.timeout(1000) })
          .then(async (response) => {
            const body = await response.json()
            return response.ok && isRecord(body) && body.owns === true
          })
          .catch(() => false)
        if (!owner) continue
        const response = await fetch(`${peer.url}/release${query}`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(30_000),
        })
        const result = await response.json()
        if (!response.ok || !isRecord(result) || result.released !== true)
          throw new Error(
            isRecord(result) && typeof result.error === "string"
              ? result.error
              : "The native writer did not release this task",
          )
        return true
      }
      return false
    },
    async close() {
      await rm(file, { force: true })
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export function isWriterConflict(error: unknown) {
  return error instanceof Error && /\bthread .+ already has an active writer\b/.test(error.message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}
