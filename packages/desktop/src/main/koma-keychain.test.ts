import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keychainName, saveKeychainName } from "./koma-keychain"

test("Debug and release preserve the existing profile's keychain service", () => {
  const root = mkdtempSync(join(tmpdir(), "koma-keychain-"))
  try {
    const legacy = join(root, "legacy")
    expect(keychainName(root, legacy)).toBe("Koma")
    mkdirSync(join(root, "desktop"))
    writeFileSync(join(root, "desktop/opencode.settings"), "{}")
    expect(keychainName(root, legacy)).toBe("OpenCode Lab")
    saveKeychainName(root, "Koma")
    expect(keychainName(root, legacy)).toBe("Koma")
    saveKeychainName(root, "OpenCode Lab")
    expect(keychainName(root, legacy)).toBe("OpenCode Lab")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
