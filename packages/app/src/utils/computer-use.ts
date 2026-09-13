import type { ComputerUseAction, ComputerUseState } from "@opencode-ai/core/koma-computer-use-types"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials, ServerHttpError } from "./server"

export async function computerUseRequest(
  server: ServerConnection.HttpBase,
  action: ComputerUseAction,
  fetcher = fetch,
) {
  const response = await fetcher(new URL("/lab/desktop/computer-use", server.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
          }
        : {}),
    },
    body: JSON.stringify(action),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    throw new ServerHttpError(
      body?.message ?? body?.data?.message ?? `Computer control request failed (${response.status})`,
      response.status,
    )
  }
  return (await response.json()) as ComputerUseState
}
