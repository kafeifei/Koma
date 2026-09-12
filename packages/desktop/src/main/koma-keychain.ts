import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Electron selects its macOS keychain service from app.name before app readiness.
// Release has a stable service of its own; legacy compatibility belongs to Debug.
export function keychainName(root: string, legacyRoot: string, release = false) {
  // "Koma Safe Storage" was also used by historical Debug builds. A release
  // service based on the stable bundle ID cannot inherit that item's access list.
  if (release) return "com.kafeifei.koma"
  const marker = join(root, "koma-brand.json")
  if (existsSync(marker)) {
    const value = JSON.parse(readFileSync(marker, "utf8"))
    if (!["Koma", "Koma Debug", "OpenCode Lab"].includes(value?.keychainName)) {
      throw new Error("Invalid Koma keychain compatibility metadata")
    }
    return value.keychainName as "Koma" | "Koma Debug" | "OpenCode Lab"
  }
  return existsSync(join(root, "desktop", "opencode.settings")) || existsSync(join(legacyRoot, "opencode.settings"))
    ? "OpenCode Lab"
    : "Koma Debug"
}

/** Called only after the profile's desktop single-instance lock has been acquired. */
export function saveKeychainName(root: string, name: "Koma" | "Koma Debug" | "OpenCode Lab" | "com.kafeifei.koma") {
  const marker = join(root, "koma-brand.json")
  const temporary = `${marker}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, keychainName: name }), { mode: 0o600 })
  renameSync(temporary, marker)
}
