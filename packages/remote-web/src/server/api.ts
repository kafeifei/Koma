import {
  GitHubAuthError,
  beginGitHubLogin,
  exchangeGitHubCode,
  getGitHubAccount,
  refreshGitHubCredential,
} from "@opencode-ai/remote/github"
import type { GitHubAuthorization, GitHubCredential, GitHubExchange } from "@opencode-ai/remote/github"
import { RemoteTunnelError, createTunnelManagement, listRemoteDevices } from "@opencode-ai/remote/tunnels"
import type { RemoteTunnelDevice } from "@opencode-ai/remote/tunnels"
import { clearSession, openSession, sealSession, sessionKey } from "./session.ts"
import type { RemoteWebSession } from "./session.ts"

const CSRF_HEADER = "x-opencode-remote-csrf"
const REFRESH_MARGIN = 60_000

export type ApiEnvironment = {
  SESSION_SECRET?: string
  REMOTE_WEB_ORIGIN?: string
}

type Dependencies = {
  beginLogin(): Promise<GitHubAuthorization>
  exchangeCode(deviceCode: string): Promise<GitHubExchange>
  account(accessToken: string): Promise<{ id: number; name: string; username: string }>
  refresh(credential: GitHubCredential): Promise<GitHubCredential>
  devices(credential: GitHubCredential): Promise<RemoteTunnelDevice[]>
  now(): number
}

const productionDependencies: Dependencies = {
  beginLogin: () => beginGitHubLogin(),
  exchangeCode: (deviceCode) => exchangeGitHubCode(deviceCode),
  account: (accessToken) => getGitHubAccount(accessToken),
  refresh: (credential) => refreshGitHubCredential(credential),
  devices: (credential) => listRemoteDevices(createTunnelManagement(() => Promise.resolve(credential.accessToken))),
  now: Date.now,
}

export function createApiHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...productionDependencies, ...overrides }
  return (request: Request, environment: ApiEnvironment = process.env) =>
    handle(request, environment, dependencies).catch((error) => failure(error, environment))
}

export const handleApi = createApiHandler()

async function handle(request: Request, environment: ApiEnvironment, dependencies: Dependencies) {
  const configuration = configured(environment)
  if (!configuration) return json({ error: "configuration" }, 503)
  if (request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "forbidden" }, 403)
  const suppliedOrigin = request.headers.get("origin")
  if (suppliedOrigin && suppliedOrigin !== configuration.origin) return json({ error: "forbidden" }, 403)
  if (request.method === "POST") {
    const invalid = await validateMutation(request, configuration.origin)
    if (invalid) return invalid
  }

  const url = new URL(request.url)
  const opened = openSession(request.headers.get("cookie"), configuration.key, dependencies.now())

  if (request.method === "POST" && url.pathname === "/api/login") {
    const authorization = await dependencies.beginLogin()
    const session: RemoteWebSession = {
      authorization: {
        ...authorization,
        nextPollAt: Math.min(authorization.expiresAt, dependencies.now() + authorization.interval * 1_000),
      },
    }
    return json(
      {
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        expiresAt: authorization.expiresAt,
        interval: authorization.interval,
      },
      200,
      sealSession(session, configuration.key, configuration.secure, { now: dependencies.now() }),
    )
  }

  if (request.method === "POST" && url.pathname === "/api/login/poll") {
    if (opened.invalid || !opened.value.authorization) {
      return json({ error: "login_not_started" }, 409, clearSession(configuration.secure))
    }
    const authorization = opened.value.authorization
    const now = dependencies.now()
    if (now >= authorization.expiresAt) {
      return json({ status: "expired" }, 200, clearSession(configuration.secure))
    }
    if (now < authorization.nextPollAt) {
      return json({ status: "pending", retryAfter: Math.ceil((authorization.nextPollAt - now) / 1_000) })
    }

    const result = await dependencies.exchangeCode(authorization.deviceCode)
    if (result.status === "denied" || result.status === "expired") {
      return json({ status: result.status }, 200, clearSession(configuration.secure))
    }
    if (result.status === "pending" || result.status === "slow_down") {
      const interval =
        result.status === "slow_down"
          ? Math.max(authorization.interval + 5, result.interval ?? 0)
          : authorization.interval
      const session: RemoteWebSession = {
        authorization: {
          ...authorization,
          interval,
          nextPollAt: Math.min(authorization.expiresAt, now + interval * 1_000),
        },
      }
      return json(
        { status: result.status, retryAfter: Math.ceil((session.authorization!.nextPollAt - now) / 1_000) },
        200,
        sealSession(session, configuration.key, configuration.secure, { now, expiresAt: opened.expiresAt }),
      )
    }
    if (result.status !== "complete") return json({ error: "github_unavailable" }, 502)

    const account = await dependencies.account(result.credential.accessToken)
    const session: RemoteWebSession = { credential: result.credential, account }
    const devices = await dependencies.devices(result.credential).catch(() => undefined)
    return json(
      {
        status: "complete",
        account,
        devices: devices ? publicDevices(devices) : [],
        warning: devices ? undefined : "devices_unavailable",
      },
      200,
      sealSession(session, configuration.key, configuration.secure, { now, expiresAt: opened.expiresAt }),
    )
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    return json({ signedIn: false }, 200, clearSession(configuration.secure))
  }

  if (request.method === "GET" && (url.pathname === "/api/session" || url.pathname === "/api/devices")) {
    if (opened.invalid || !opened.value.credential || !opened.value.account) {
      return json(
        url.pathname === "/api/session"
          ? { signedIn: false, account: null, devices: [] }
          : { error: "authentication_required" },
        url.pathname === "/api/session" ? 200 : 401,
        opened.invalid ? clearSession(configuration.secure) : undefined,
      )
    }
    const credential = await activeCredential(opened.value.credential, dependencies)
    const cookie = sealSession({ credential, account: opened.value.account }, configuration.key, configuration.secure, {
      now: dependencies.now(),
      expiresAt: opened.expiresAt,
    })
    const devices = await dependencies.devices(credential).catch(() => undefined)
    if (!devices) return json({ error: "devices_unavailable" }, 502, cookie)
    const projected = publicDevices(devices)
    if (url.pathname === "/api/devices") return json({ devices: projected }, 200, cookie)
    return json({ signedIn: true, account: opened.value.account, devices: projected }, 200, cookie)
  }

  return json({ error: "not_found" }, 404)
}

async function activeCredential(credential: GitHubCredential, dependencies: Dependencies) {
  if (credential.expiresAt === undefined || credential.expiresAt > dependencies.now() + REFRESH_MARGIN) {
    return credential
  }
  return dependencies.refresh(credential)
}

async function validateMutation(request: Request, origin: string) {
  if (request.headers.get("origin") !== origin) return json({ error: "forbidden" }, 403)
  if (request.headers.get(CSRF_HEADER) !== "1") return json({ error: "forbidden" }, 403)
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "json_required" }, 415)
  }
  const body = await request.json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return json({ error: "invalid_request" }, 400)
  }
}

function configured(environment: ApiEnvironment) {
  const key = sessionKey(environment.SESSION_SECRET)
  if (!key || !environment.REMOTE_WEB_ORIGIN || !URL.canParse(environment.REMOTE_WEB_ORIGIN)) return
  const url = new URL(environment.REMOTE_WEB_ORIGIN)
  const local =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (!local && url.protocol !== "https:")
  ) {
    return
  }
  return { key, origin: url.origin, secure: !local }
}

function publicDevices(devices: RemoteTunnelDevice[]) {
  return devices.map((device) => ({
    id: device.id,
    name: device.name,
    online: device.online,
    url: device.online === true ? device.url : null,
  }))
}

function failure(error: unknown, environment: ApiEnvironment) {
  const configuration = configured(environment)
  if (error instanceof GitHubAuthError && error.code === "reauth_required") {
    return json(
      { error: "authentication_required" },
      401,
      configuration ? clearSession(configuration.secure) : undefined,
    )
  }
  if (error instanceof GitHubAuthError) return json({ error: "github_unavailable" }, 502)
  if (error instanceof RemoteTunnelError) return json({ error: "devices_unavailable" }, 502)
  return json({ error: "internal" }, 500)
}

function json(value: object, status = 200, cookie?: string) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  })
  if (cookie) headers.set("Set-Cookie", cookie)
  return new Response(JSON.stringify(value), { status, headers })
}
