export type Account = {
  id: number
  name: string
  username: string
}

export type Device = {
  id: string
  name: string
  online: boolean | null
  url: string | null
}

export type Authorization = {
  userCode: string
  verificationUri: string
  expiresAt: number
  interval: number
}

export type Session =
  | { signedIn: false; account: null; devices: Device[] }
  | { signedIn: true; account: Account; devices: Device[] }

export type PollResult =
  | { status: "pending" | "slow_down"; retryAfter: number }
  | { status: "denied" | "expired" }
  | { status: "complete"; account: Account; devices: Device[]; warning?: "devices_unavailable" }

export class RemoteWebError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(`Remote Web request failed: ${code}`)
    this.name = "RemoteWebError"
  }
}

export const remoteWeb = {
  session: () => request<Session>("/api/session"),
  login: () => request<Authorization>("/api/login", true),
  poll: () => request<PollResult>("/api/login/poll", true),
  logout: () => request<{ signedIn: false }>("/api/logout", true),
  devices: () => request<{ devices: Device[] }>("/api/devices"),
}

async function request<T>(path: string, mutation = false) {
  const response = await fetch(path, {
    method: mutation ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: mutation
      ? {
          "Content-Type": "application/json",
          "X-OpenCode-Remote-CSRF": "1",
        }
      : { Accept: "application/json" },
    body: mutation ? "{}" : undefined,
  })
  const value = (await response.json().catch(() => ({ error: "invalid_response" }))) as T & { error?: string }
  if (!response.ok) throw new RemoteWebError(value.error ?? "request_failed", response.status)
  return value
}
