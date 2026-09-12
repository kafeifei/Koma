import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keychainName, saveKeychainName } from "./koma-keychain"

test("only Debug preserves a legacy profile's keychain service; release never reads its marker", () => {
  const root = mkdtempSync(join(tmpdir(), "koma-keychain-"))
  try {
    const legacy = join(root, "legacy")
    expect(keychainName(root, legacy)).toBe("Koma Debug")
    expect(keychainName(root, legacy, true)).toBe("com.kafeifei.koma")
    mkdirSync(join(root, "desktop"))
    writeFileSync(join(root, "desktop/opencode.settings"), "{}")
    expect(keychainName(root, legacy)).toBe("OpenCode Lab")
    expect(keychainName(root, legacy, true)).toBe("com.kafeifei.koma")
    saveKeychainName(root, "Koma")
    expect(keychainName(root, legacy)).toBe("Koma")
    saveKeychainName(root, "OpenCode Lab")
    expect(keychainName(root, legacy)).toBe("OpenCode Lab")
    const marker = readFileSync(join(root, "koma-brand.json"), "utf8")
    saveKeychainName(root, keychainName(root, legacy, true))
    expect(readFileSync(join(root, "koma-brand.json"), "utf8")).toBe(marker)
    expect(keychainName(root, legacy)).toBe("OpenCode Lab")
    writeFileSync(join(root, "koma-brand.json"), "invalid old marker")
    expect(keychainName(root, legacy, true)).toBe("com.kafeifei.koma")
    expect(() => keychainName(root, legacy)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
