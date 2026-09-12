import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertReleaseSource, notaryCredentials } from "./macos-release"

test("rejects missing or incomplete notarization credentials before building", () => {
  expect(() => notaryCredentials({})).toThrow("Configure")
  expect(() => notaryCredentials({ APPLE_API_KEY: "/key.p8", APPLE_API_KEY_ID: "key-id" })).toThrow("Configure")
  expect(notaryCredentials({ APPLE_KEYCHAIN_PROFILE: "release" })).toEqual(["--keychain-profile", "release"])
  expect(
    notaryCredentials({ APPLE_API_KEY: "/key.p8", APPLE_API_KEY_ID: "key-id", APPLE_API_ISSUER: "issuer" }),
  ).toEqual(["--key", "/key.p8", "--key-id", "key-id", "--issuer", "issuer"])
})

test("release source must be clean and match main", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "koma-release-source-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" })
  try {
    git("init", "--initial-branch=main")
    git("config", "user.name", "Release Test")
    git("config", "user.email", "release@example.invalid")
    git("commit", "--allow-empty", "-m", "main")
    expect(() => assertReleaseSource(cwd)).not.toThrow()
    await writeFile(join(cwd, "uncommitted"), "candidate")
    expect(() => assertReleaseSource(cwd)).toThrow("clean checkout")
    git("switch", "-c", "codex/candidate")
    git("add", ".")
    git("commit", "-m", "candidate")
    expect(() => assertReleaseSource(cwd)).toThrow("main commit")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
