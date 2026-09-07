import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import type { GitHubCredential } from "@opencode-ai/remote/github"

const COOKIE_NAME = "oc_remote_session"
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30
const SESSION_MAX_AGE = COOKIE_MAX_AGE * 1_000
const AAD = Buffer.from("opencode-lab-remote-session-v1")

export type RemoteWebSession = {
  authorization?: {
    deviceCode: string
    userCode: string
    verificationUri: string
    expiresAt: number
    interval: number
    nextPollAt: number
  }
  credential?: GitHubCredential
  account?: {
    id: number
    name: string
    username: string
  }
}

export type OpenedSession = {
  value: RemoteWebSession
  invalid: boolean
  expiresAt?: number
}

export function sessionKey(secret: string | undefined) {
  if (!secret || !/^(?:[0-9a-fA-F]{2}){32,}$/.test(secret)) return
  return createHash("sha256").update(Buffer.from(secret, "hex")).digest()
}

export function openSession(cookieHeader: string | null, key: Buffer, now = Date.now()): OpenedSession {
  const sealed = readCookie(cookieHeader)
  if (!sealed) return { value: {}, invalid: false }
  if (sealed.length > 16_384) return { value: {}, invalid: true }
  const parts = sealed.split(".")
  if (parts.length !== 4 || parts[0] !== "v1") return { value: {}, invalid: true }

  try {
    const decrypted = decrypt(parts, key)
    if (decrypted.expiresAt <= now) return { value: {}, invalid: true }
    return { value: decrypted.value, invalid: false, expiresAt: decrypted.expiresAt }
  } catch {
    return { value: {}, invalid: true }
  }
}

export function sealSession(
  value: RemoteWebSession,
  key: Buffer,
  secure: boolean,
  options: { now?: number; expiresAt?: number } = {},
) {
  const now = options.now ?? Date.now()
  const expiresAt = options.expiresAt ?? now + SESSION_MAX_AGE
  if (!positiveInteger(expiresAt) || expiresAt <= now || expiresAt > now + SESSION_MAX_AGE) {
    throw new Error("invalid session expiration")
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(AAD)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ expiresAt, value }), "utf8"), cipher.final()])
  const sealed = [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".")
  return cookie(sealed, secure, `Max-Age=${Math.ceil((expiresAt - now) / 1_000)}`)
}

export function clearSession(secure: boolean) {
  return cookie("", secure, "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT")
}

function decrypt(parts: string[], key: Buffer) {
  const iv = Buffer.from(parts[1], "base64url")
  const tag = Buffer.from(parts[2], "base64url")
  const encrypted = Buffer.from(parts[3], "base64url")
  if (iv.length !== 12 || tag.length !== 16 || encrypted.length > 12_000) throw new Error("invalid session")
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  const raw = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
  if (raw.length > 10_000) throw new Error("invalid session")
  const envelope: unknown = JSON.parse(raw)
  if (!record(envelope) || !positiveInteger(envelope.expiresAt)) throw new Error("invalid session")
  return { expiresAt: envelope.expiresAt, value: validateSession(envelope.value) }
}

function validateSession(value: unknown): RemoteWebSession {
  if (!record(value)) throw new Error("invalid session")
  const authorization = value.authorization
  const credential = value.credential
  const account = value.account
  if (authorization !== undefined && !validAuthorization(authorization)) throw new Error("invalid session")
  if (credential !== undefined && !validCredential(credential)) throw new Error("invalid session")
  if (account !== undefined && !validAccount(account)) throw new Error("invalid session")
  return { authorization, credential, account }
}

function validAuthorization(value: unknown): value is NonNullable<RemoteWebSession["authorization"]> {
  return (
    record(value) &&
    safeString(value.deviceCode) &&
    safeString(value.userCode) &&
    value.verificationUri === "https://github.com/login/device" &&
    positiveInteger(value.expiresAt) &&
    positiveInteger(value.interval) &&
    positiveInteger(value.nextPollAt)
  )
}

function validCredential(value: unknown): value is GitHubCredential {
  return (
    record(value) &&
    safeString(value.accessToken) &&
    (value.expiresAt === undefined || positiveInteger(value.expiresAt)) &&
    (value.refreshToken === undefined || safeString(value.refreshToken))
  )
}

function validAccount(value: unknown): value is NonNullable<RemoteWebSession["account"]> {
  return record(value) && positiveInteger(value.id) && safeString(value.name) && safeString(value.username)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\u0000-\u001f\u007f]/.test(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function readCookie(header: string | null) {
  if (!header) return
  return header
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === COOKIE_NAME)
    ?.slice(1)
    .join("=")
}

function cookie(value: string, secure: boolean, ...lifetime: string[]) {
  return [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...lifetime,
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}
