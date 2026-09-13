import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials, ServerHttpError } from "./server"

export async function prepareProjectlessWorkspace(server: ServerConnection.HttpBase, key?: string, fetcher = fetch) {
  const response = await fetcher(new URL("/lab/desktop/projectless-workspace", server.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
          }
        : {}),
    },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json()
  if (!response.ok) throw new ServerHttpError(body?.message ?? "Workspace preparation failed", response.status)
  if (typeof body.directory !== "string" || !body.directory) throw new Error("Missing workspace directory")
  return body.directory as string
}
