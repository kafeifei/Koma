import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { RemoteTunnelError } from "@opencode-ai/remote/tunnels"
import { createApiHandler } from "./api.ts"
import { openSession, sealSession, sessionKey } from "./session.ts"

const origin = "https://remote.example"
const environment = { REMOTE_WEB_ORIGIN: origin, SESSION_SECRET: "22".repeat(32) }
const start = 2_000_000_000_000

describe("remote web API", () => {
  test("requires exact same-origin JSON mutations with the CSRF header", async () => {
    const handle = createApiHandler()
    assert.equal((await handle(new Request(`${origin}/api/logout`, { method: "POST" }), environment)).status, 403)
    assert.equal((await handle(mutation("/api/logout", undefined, "https://other.example"), environment)).status, 403)
    assert.equal(
      (
        await handle(
          new Request(`${origin}/api/logout`, {
            method: "POST",
            headers: { Origin: origin, "X-OpenCode-Remote-CSRF": "1", "Content-Type": "text/plain" },
            body: "{}",
          }),
          environment,
        )
      ).status,
      415,
    )
  })

  test("keeps device codes and credentials out of API responses", async () => {
    let now = start
    const handle = createApiHandler({
      now: () => now,
      beginLogin: async () => ({
        deviceCode: "private-device-code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        expiresAt: start + 60_000,
        interval: 5,
      }),
      exchangeCode: async () => ({
        status: "complete",
        credential: { accessToken: "private-access-token", refreshToken: "private-refresh-token" },
      }),
      account: async () => ({ id: 1, name: "Ada", username: "ada" }),
      devices: async () => [device()],
    })

    const login = await handle(mutation("/api/login"), environment)
    const loginText = await login.text()
    assert.equal(login.status, 200)
    assert.ok(loginText.includes("ABCD-EFGH"))
    assert.ok(!loginText.includes("private-device-code"))
    now += 5_000

    const poll = await handle(mutation("/api/login/poll", responseCookie(login)), environment)
    const pollText = await poll.text()
    assert.equal(poll.status, 200)
    assert.ok(!pollText.includes("private-access-token"))
    assert.ok(!pollText.includes("private-refresh-token"))
    assert.ok(pollText.includes("computer-one"))
  })

  test("persists a rotated credential when device listing fails", async () => {
    const key = sessionKey(environment.SESSION_SECRET)!
    const existing = sealSession(
      {
        credential: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: start },
        account: { id: 1, name: "Ada", username: "ada" },
      },
      key,
      true,
      { now: start - 1_000 },
    )
    const handle = createApiHandler({
      now: () => start,
      refresh: async () => ({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: start + 3_600_000,
      }),
      devices: async (credential) => {
        assert.equal(credential.accessToken, "new-access")
        throw new RemoteTunnelError("request_failed")
      },
    })

    const response = await handle(
      new Request(`${origin}/api/devices`, { headers: { Cookie: cookie(existing), Origin: origin } }),
      environment,
    )
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: "devices_unavailable" })
    const opened = openSession(responseCookie(response), key, start)
    assert.equal(opened.invalid, false)
    assert.deepEqual(opened.value.credential, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: start + 3_600_000,
    })
  })

  test("rejects deployment origins containing credentials", async () => {
    const response = await createApiHandler()(new Request(`${origin}/api/session`), {
      ...environment,
      REMOTE_WEB_ORIGIN: "https://user:password@remote.example",
    })
    assert.equal(response.status, 503)
  })
})

function mutation(path: string, cookieHeader?: string, requestOrigin = origin) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      "X-OpenCode-Remote-CSRF": "1",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: "{}",
  })
}

function device() {
  return {
    id: "cluster/computer-one",
    name: "computer-one",
    online: true,
    url: "https://computer-one.devtunnels.ms",
    port: 3000,
    clusterId: "cluster",
    tunnelId: "computer-one",
  }
}

function responseCookie(response: Response) {
  const value = response.headers.get("set-cookie")
  if (!value) throw new Error("missing session cookie")
  return cookie(value)
}

function cookie(value: string) {
  return value.split(";", 1)[0]
}
