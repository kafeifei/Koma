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
