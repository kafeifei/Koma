import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Electron selects its macOS keychain service from app.name before app readiness.
// Keep this stable across Debug/release builds and preserve legacy encrypted cookies/tokens.
export function keychainName(root: string, legacyRoot: string) {
  const marker = join(root, "koma-brand.json")
  if (existsSync(marker)) {
    const value = JSON.parse(readFileSync(marker, "utf8"))
    if (value?.keychainName !== "Koma" && value?.keychainName !== "OpenCode Lab") {
      throw new Error("Invalid Koma keychain compatibility metadata")
    }
    return value.keychainName as "Koma" | "OpenCode Lab"
  }
  return existsSync(join(root, "desktop", "opencode.settings")) || existsSync(join(legacyRoot, "opencode.settings"))
    ? "OpenCode Lab"
    : "Koma"
}

/** Called only after the profile's desktop single-instance lock has been acquired. */
export function saveKeychainName(root: string, name: "Koma" | "OpenCode Lab") {
  const marker = join(root, "koma-brand.json")
  const temporary = `${marker}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, keychainName: name }), { mode: 0o600 })
  renameSync(temporary, marker)
}
