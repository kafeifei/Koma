import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import { handleApi } from "./api.ts"
import type { ApiEnvironment } from "./api.ts"

const BODY_LIMIT = 64 * 1024

export async function handleNodeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  environment: ApiEnvironment = process.env,
) {
  const result = await toRequest(request, environment)
    .then((webRequest) => handleApi(webRequest, environment))
    .catch(
      (error) =>
        new Response(JSON.stringify({ error: error instanceof BodyTooLargeError ? "request_too_large" : "internal" }), {
          status: error instanceof BodyTooLargeError ? 413 : 500,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        }),
    )

  response.statusCode = result.status
  result.headers.forEach((value, name) => response.setHeader(name, value))
  response.end(Buffer.from(await result.arrayBuffer()))
}

async function toRequest(request: IncomingMessage, environment: ApiEnvironment) {
  const origin =
    environment.REMOTE_WEB_ORIGIN && URL.canParse(environment.REMOTE_WEB_ORIGIN)
      ? new URL(environment.REMOTE_WEB_ORIGIN).origin
      : "http://127.0.0.1"
  const method = request.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request)
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: headers(request.headers),
    body,
  }
  if (body) init.duplex = "half"
  return new Request(new URL(request.url ?? "/", origin), init)
}

function headers(input: IncomingHttpHeaders) {
  const result = new Headers()
  Object.entries(input).forEach(([name, value]) => {
    if (typeof value === "string") result.set(name, value)
    if (Array.isArray(value)) result.set(name, value.join(", "))
  })
  return result
}

function readBody(request: IncomingMessage) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    request.on("data", (chunk: Buffer) => {
      length += chunk.length
      if (length <= BODY_LIMIT) chunks.push(chunk)
    })
    request.on("end", () => {
      if (length > BODY_LIMIT) {
        reject(new BodyTooLargeError())
        return
      }
      resolve(Uint8Array.from(Buffer.concat(chunks)).buffer)
    })
    request.on("error", reject)
  })
}

class BodyTooLargeError extends Error {}
