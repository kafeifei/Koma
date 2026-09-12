import { expect, test } from "bun:test"
import { createKomaCredentials } from "../src/koma/credentials"

test("native credential writes and sign-out remain ordered across asynchronous keychain calls", async () => {
  let value: string | null = null
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: string[] = []
  const credentials = createKomaCredentials("/test/profile", {
    async get() {
      return value
    },
    async set(input: { value: string }) {
      calls.push("write")
      started.resolve()
      await release.promise
      value = input.value
    },
    async delete() {
      calls.push("clear")
      value = null
      return true
    },
  } as typeof Bun.secrets)
  const writing = credentials.write({ accessToken: "test-only" })
  await started.promise
  const clearing = credentials.clear()
  release.resolve()
  await Promise.all([writing, clearing])
  expect(calls).toEqual(["write", "clear"])
  expect(await credentials.read()).toBeUndefined()
  await expect(credentials.write({ accessToken: 3 })).rejects.toThrow()
  expect(calls).toHaveLength(2)
})

test("relocating a profile keeps the existing system credential item without copying or rewriting it", async () => {
  const { mkdtemp, mkdir, readFile, rename, rm, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { createHash } = await import("node:crypto")
  const home = await mkdtemp(join(tmpdir(), "koma-credential-relocation-"))
  try {
    const previous = join(home, ".opencode")
    const root = join(home, ".koma")
    await mkdir(previous)
    const items = new Map<string, string>()
    const keys: Array<{ service: string; name: string }> = []
    const secrets = {
      async get(key: { service: string; name: string }) {
        keys.push(key)
        return items.get(JSON.stringify(key)) ?? null
      },
      async set({ value, ...key }: { service: string; name: string; value: string }) {
        items.set(JSON.stringify(key), value)
      },
      async delete(key: { service: string; name: string }) {
        return items.delete(JSON.stringify(key))
      },
    } as typeof Bun.secrets
    await createKomaCredentials(previous, secrets).write({ accessToken: "fixture-only" })
    await writeFile(
      join(previous, "storage.json"),
      JSON.stringify({
        version: 2,
        backendProtocol: 1,
        source: null,
        status: "complete",
        database: "opencode.db",
        credentialScope: createHash("sha256").update(previous).digest("hex"),
      }),
    )
    await rename(previous, root)
    expect(await createKomaCredentials(root, secrets).read()).toEqual({ accessToken: "fixture-only" })
    expect(items.size).toBe(1)
    expect(keys[0]).toEqual({
      service: "com.kafeifei.koma.remote.tauri",
      name: createHash("sha256").update(previous).digest("hex"),
    })
    await createKomaCredentials(root, secrets).clear()
    expect(items.size).toBe(0)
    const manifest = JSON.parse(await readFile(join(root, "storage.json"), "utf8"))
    await writeFile(join(root, "storage.json"), JSON.stringify({ ...manifest, credentialScope: "invalid" }))
    expect(() => createKomaCredentials(root, secrets)).toThrow("Invalid OpenCode storage credential scope")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
