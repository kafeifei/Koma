// Public client identifier used by Code OSS and Sandy; see ../NOTICE.
// It is configurable, and is not an Koma-owned OAuth registration.
export const GITHUB_CLIENT_ID = "01ab8ac9400c4e429b23"

export type GitHubAuthorization = {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number
  interval: number
}

export type GitHubCredential = {
  accessToken: string
  expiresAt?: number
  refreshToken?: string
}

export type GitHubExchange =
  | { status: "pending" | "denied" | "expired" }
  | { status: "slow_down"; interval?: number }
  | { status: "complete"; credential: GitHubCredential }

type GitHubOptions = { signal?: AbortSignal; clientId?: string }
type GitHubAuthErrorCode =
  | "cancelled"
  | "network_error"
  | "rate_limited"
  | "invalid_response"
  | "invalid_client"
  | "device_flow_disabled"
  | "invalid_device_code"
  | "denied"
  | "expired"
  | "reauth_required"
  | "request_failed"

export class GitHubAuthError extends Error {
  constructor(public readonly code: GitHubAuthErrorCode) {
    // Never include provider response bodies, tokens, or transport errors.
    super(`GitHub authentication failed: ${code}`)
    this.name = "GitHubAuthError"
  }
}

type GitHubTransport = {
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

/** Inject transport and time for isolated tests without replacing global APIs. */
export function createGitHubClient(transport: GitHubTransport = {}) {
  const send = transport.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const now = transport.now ?? Date.now
  const wait = transport.wait ?? delay

  async function request(url: string, init: RequestInit, signal?: AbortSignal) {
    if (signal?.aborted) throw new GitHubAuthError("cancelled")
    const response = await send(url, {
      ...init,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      redirect: "error",
    }).catch(() => {
      throw new GitHubAuthError(signal?.aborted ? "cancelled" : "network_error")
    })
    if (signal?.aborted) throw new GitHubAuthError("cancelled")
    if (response.status === 429) throw new GitHubAuthError("rate_limited")
    if (response.status === 401) throw new GitHubAuthError("reauth_required")
    if (!response.ok) throw new GitHubAuthError("request_failed")
    const data: unknown = await response.json().catch(() => {
      throw new GitHubAuthError("invalid_response")
    })
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new GitHubAuthError("invalid_response")
    return data as Record<string, unknown>
  }

  function post(path: string, values: Record<string, string>, options: GitHubOptions) {
    return request(
      `https://github.com/login/${path}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Koma",
        },
        body: new URLSearchParams({ client_id: clientId(options), ...values }),
      },
      options.signal,
    )
  }

  async function beginGitHubLogin(options: GitHubOptions = {}): Promise<GitHubAuthorization> {
    // Dev Tunnels requires organization membership scope even for owner-only tunnels.
    const data = await post("device/code", { scope: "read:user read:org" }, options)
    if (data.error !== undefined) throw providerError(data.error)
    if (data.verification_uri !== "https://github.com/login/device") throw new GitHubAuthError("invalid_response")
    return {
      deviceCode: requireString(data.device_code),
      userCode: requireString(data.user_code),
      verificationUri: data.verification_uri,
      expiresAt: expiration(data.expires_in, now()),
      interval: positiveNumber(data.interval),
    }
  }

  async function exchangeGitHubCode(deviceCode: string, options: GitHubOptions = {}): Promise<GitHubExchange> {
    const data = await post(
      "oauth/access_token",
      { device_code: requireString(deviceCode), grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
      options,
    )
    if (data.error === "authorization_pending") return { status: "pending" }
    if (data.error === "slow_down") {
      return { status: "slow_down", interval: data.interval === undefined ? undefined : positiveNumber(data.interval) }
    }
    if (data.error === "access_denied") return { status: "denied" }
    if (data.error === "expired_token" || data.error === "token_expired") return { status: "expired" }
    if (data.error !== undefined) throw providerError(data.error)
    return { status: "complete", credential: credential(data, now()) }
  }

  async function waitGitHubLogin(auth: GitHubAuthorization, options: GitHubOptions = {}): Promise<GitHubCredential> {
    let interval = positiveNumber(auth.interval)
    if (!Number.isSafeInteger(auth.expiresAt)) throw new GitHubAuthError("invalid_response")
    while (true) {
      if (options.signal?.aborted) throw new GitHubAuthError("cancelled")
      const remaining = auth.expiresAt - now()
      if (remaining <= 0) throw new GitHubAuthError("expired")
      // Also delay the first request; GitHub defines a minimum polling interval.
      await wait(Math.min(interval * 1_000, remaining), options.signal)
      if (options.signal?.aborted) throw new GitHubAuthError("cancelled")
      if (now() >= auth.expiresAt) throw new GitHubAuthError("expired")
      const result = await exchangeGitHubCode(auth.deviceCode, options)
      if (result.status === "complete") return result.credential
      if (result.status === "denied" || result.status === "expired") throw new GitHubAuthError(result.status)
      if (result.status === "slow_down") interval = Math.max(interval + 5, result.interval ?? 0)
    }
  }

  async function refreshGitHubCredential(current: GitHubCredential, options: GitHubOptions = {}) {
    if (!current.refreshToken) throw new GitHubAuthError("reauth_required")
    // GitHub exempts device-flow refresh tokens from the client_secret requirement.
    // Refresh rotates the token pair: callers must atomically replace their saved credential.
    const data = await post(
      "oauth/access_token",
      { grant_type: "refresh_token", refresh_token: requireString(current.refreshToken) },
      options,
    )
    if (data.error !== undefined) throw providerError(data.error)
    return credential(data, now())
  }

  async function getGitHubAccount(accessToken: string, options: { signal?: AbortSignal } = {}) {
    const data = await request(
      "https://api.github.com/user",
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${requireString(accessToken)}`,
          "User-Agent": "Koma",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      options.signal,
    )
    const username = requireString(data.login)
    return {
      id: positiveNumber(data.id),
      name: typeof data.name === "string" && data.name.trim() ? data.name : username,
      username,
    }
  }

  return { beginGitHubLogin, exchangeGitHubCode, waitGitHubLogin, refreshGitHubCredential, getGitHubAccount }
}

const github = createGitHubClient()
export const beginGitHubLogin = github.beginGitHubLogin
export const exchangeGitHubCode = github.exchangeGitHubCode
export const waitGitHubLogin = github.waitGitHubLogin
export const refreshGitHubCredential = github.refreshGitHubCredential
export const getGitHubAccount = github.getGitHubAccount

function clientId(options: GitHubOptions) {
  const value = options.clientId ?? GITHUB_CLIENT_ID
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(value)) throw new GitHubAuthError("invalid_client")
  return value
}

function requireString(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 16_384 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GitHubAuthError("invalid_response")
  }
  return value
}

function positiveNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubAuthError("invalid_response")
  }
  return value
}

function expiration(value: unknown, now: number) {
  const result = now + positiveNumber(value) * 1_000
  if (!Number.isSafeInteger(result)) throw new GitHubAuthError("invalid_response")
  return result
}

function credential(data: Record<string, unknown>, now: number): GitHubCredential {
  if (data.token_type !== "bearer") throw new GitHubAuthError("invalid_response")
  return {
    accessToken: requireString(data.access_token),
    expiresAt: data.expires_in === undefined ? undefined : expiration(data.expires_in, now),
    refreshToken: data.refresh_token === undefined ? undefined : requireString(data.refresh_token),
  }
}

function providerError(code: unknown) {
  if (code === "incorrect_client_credentials") return new GitHubAuthError("invalid_client")
  if (code === "device_flow_disabled") return new GitHubAuthError("device_flow_disabled")
  if (code === "incorrect_device_code") return new GitHubAuthError("invalid_device_code")
  if (code === "bad_refresh_token" || code === "bad_verification_code") return new GitHubAuthError("reauth_required")
  return new GitHubAuthError("request_failed")
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new GitHubAuthError("cancelled"))
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(new GitHubAuthError("cancelled"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener("abort", abort, { once: true })
  })
}
