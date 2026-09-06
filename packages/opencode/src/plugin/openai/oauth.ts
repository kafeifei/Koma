import type { Auth } from "../../auth"

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const ISSUER = "https://auth.openai.com"

export interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  chatgpt_compute_residency?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    chatgpt_compute_residency?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

export function extractResidency(token: string): string | undefined {
  const claims = parseJwtClaims(token)
  const residency =
    claims?.["https://api.openai.com/auth"]?.chatgpt_compute_residency ?? claims?.chatgpt_compute_residency
  if (!residency || residency === "no_constraint") return undefined
  return residency
}

async function refreshAccessToken(refreshToken: string, issuer = ISSUER): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

export type Refresh = { accessToken: string; accountId: string }
export type Credentials = {
  get: (refresh?: Refresh) => Promise<Auth.Oauth | undefined>
}

// Both native Codex and the built-in provider use this one refresh owner.
// The store must reject commits after logout, account selection, or replacement.
export function makeCredentials(
  store: {
    read: () => Promise<Auth.Snapshot>
    commit: (expected: Auth.Snapshot, info: Auth.Oauth) => Promise<boolean>
  },
  issuer = ISSUER,
): Credentials {
  let pending: Promise<Auth.Oauth | undefined> | undefined
  return {
    get: async (refresh) => {
      if (pending) {
        await pending
        // Reread the selected credential after the shared refresh completes.
      }
      const snapshot = await store.read()
      if (snapshot.info?.type !== "oauth") return
      const auth = snapshot.info
      if (refresh && accountId(auth) !== refresh.accountId) throw new Error("OpenAI account selection changed")
      if (auth.access && auth.expires > Date.now() && (!refresh || auth.access !== refresh.accessToken)) return auth
      if (pending) return pending
      pending = (async () => {
        const tokens = await refreshAccessToken(auth.refresh, issuer)
        const selected = accountId(auth)
        const account = extractAccountId(tokens) || selected
        if (!tokens.access_token || !tokens.refresh_token)
          throw new Error("OpenAI refresh returned incomplete credentials")
        if (selected && account !== selected) throw new Error("OpenAI refresh changed the selected account")
        const info: Auth.Oauth = {
          type: "oauth",
          refresh: tokens.refresh_token,
          access: tokens.access_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          ...(account && { accountId: account }),
        }
        if (!(await store.commit(snapshot, info))) throw new Error("OpenAI authentication changed during refresh")
        return info
      })().finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}

export function accountId(auth: Auth.Oauth) {
  return auth.accountId || extractAccountId({ access_token: auth.access, id_token: "", refresh_token: "" })
}
