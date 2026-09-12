import { describe, expect, test } from "bun:test"
import { providerCredentials } from "../src/provider-credentials.js"
import { CodexProviders } from "../src/providers.js"

const provider = {
  id: "xd",
  name: "XD",
  baseURL: "https://api.xd.example/v1",
  models: [],
}

describe("providerCredentials", () => {
  test("keeps provider keys out of config and resolves rotations through the configured curl command", async () => {
    let baseURL = provider.baseURL
    let key = "xd-key-first"
    const credentials = providerCredentials(
      source((providerID, requestedBaseURL) => {
        if (providerID !== provider.id || requestedBaseURL !== baseURL) return
        return key
      }),
    )

    try {
      const config = await credentials.config(provider)
      expect(JSON.stringify(config)).not.toContain(key)
      expect(await curl(config.auth)).toEqual({ exitCode: 0, stdout: key, stderr: "" })

      key = "xd-key-rotated"
      expect(JSON.stringify(config)).not.toContain(key)
      expect(await curl(config.auth)).toEqual({ exitCode: 0, stdout: key, stderr: "" })

      baseURL = "https://api.xd.example/v2"
      const rejected = await curl(config.auth)
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.stdout).toBe("")
      expect(rejected.stderr).toContain("403")

      const current = await credentials.config({ ...provider, baseURL })
      expect(await curl(current.auth)).toEqual({ exitCode: 0, stdout: key, stderr: "" })
    } finally {
      await credentials.close()
    }
  })

  test("pins OAuth account headers and credential routes to the selected Provider account", async () => {
    let selected = "account-1"
    const credentials = providerCredentials({
      list: async () => [],
      onChange: () => () => {},
      key: async (_id, _base, accountID) => (accountID === selected ? "provider-token" : undefined),
    })
    try {
      const first = await credentials.config({ ...provider, accountID: selected })
      expect(first.http_headers).toEqual({ "ChatGPT-Account-Id": "account-1" })
      expect((await curl(first.auth)).stdout).toBe("provider-token")
      selected = "account-2"
      expect((await curl(first.auth)).exitCode).not.toBe(0)
      const second = await credentials.config({ ...provider, accountID: selected })
      expect(second.auth.args.at(-1)).not.toBe(first.auth.args.at(-1))
      expect((await curl(second.auth)).stdout).toBe("provider-token")
    } finally {
      await credentials.close()
    }
  })

  test("rejects unauthorized and nonexistent HTTP routes", async () => {
    const credentials = providerCredentials(source(() => "xd-key"))

    try {
      const config = await credentials.config(provider)
      const url = config.auth.args.at(-1)!
      const header = config.auth.args[config.auth.args.indexOf("--header") + 1]!
      const unauthorized = await fetch(url)
      expect(unauthorized.status).toBe(401)
      expect(await unauthorized.text()).toBe("")

      const missing = await fetch(new URL("/missing", url), {
        headers: { Authorization: header.slice("Authorization: ".length) },
      })
      expect(missing.status).toBe(404)
      expect(await missing.text()).toBe("")
    } finally {
      await credentials.close()
    }
  })

  test("closes the listener and refuses new config", async () => {
    const credentials = providerCredentials(source(() => "xd-key"))
    const config = await credentials.config(provider)
    await credentials.close()

    const closed = await curl(config.auth)
    expect(closed.exitCode).not.toBe(0)
    expect(closed.stdout).toBe("")
    await expect(credentials.config(provider)).rejects.toThrow("credentials are unavailable")
  })
})

function source(key: (providerID: string, baseURL: string) => string | undefined): CodexProviders.Interface {
  return {
    list: async () => [],
    key: async (providerID, baseURL) => key(providerID, baseURL),
    onChange: () => () => {},
  }
}

async function curl(auth: { command: string; args: readonly string[] }) {
  const child = Bun.spawn([auth.command, ...auth.args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}
