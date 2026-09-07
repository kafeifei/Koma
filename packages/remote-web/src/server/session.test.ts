import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { openSession, sealSession, sessionKey } from "./session.ts"

const key = sessionKey("11".repeat(32))!
const now = 2_000_000_000_000
const month = 30 * 24 * 60 * 60 * 1_000

describe("remote web session", () => {
  test("expires sealed credentials at the original absolute deadline", () => {
    const first = sealSession(
      {
        credential: { accessToken: "access-secret", refreshToken: "refresh-secret" },
        account: { id: 1, name: "Ada", username: "ada" },
      },
      key,
      true,
      { now },
    )
    assert.ok(first.includes("HttpOnly"))
    assert.ok(first.includes("SameSite=Strict"))
    assert.ok(first.includes("Secure"))
    assert.ok(first.includes("Max-Age=2592000"))
    assert.ok(!first.includes("access-secret"))

    const opened = openSession(cookie(first), key, now + 24 * 60 * 60 * 1_000)
    assert.equal(opened.invalid, false)
    assert.equal(opened.value.account?.username, "ada")

    const renewed = sealSession(opened.value, key, true, {
      now: now + 24 * 60 * 60 * 1_000,
      expiresAt: opened.expiresAt,
    })
    assert.ok(renewed.includes("Max-Age=2505600"))
    assert.equal(openSession(cookie(renewed), key, now + month).invalid, true)
  })

  test("rejects tampered and legacy payloads without exposing their contents", () => {
    const sealed = sealSession({ credential: { accessToken: "secret" } }, key, false, { now })
    const value = cookie(sealed).replace(/.$/, (character) => (character === "a" ? "b" : "a"))
    assert.equal(openSession(value, key, now).invalid, true)
    assert.equal(openSession("oc_remote_session=v1.a.b.c", key, now).invalid, true)
  })
})

function cookie(value: string) {
  return value.split(";", 1)[0]
}
