import { resolve, relative, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

export const repository = fileURLToPath(new URL("../../..", import.meta.url))
export const packageRoot = join(repository, "packages", "desktop-tauri")
export const testRoot = join(repository, ".local", "desktop-tests")
export const profile = join(testRoot, "tauri", "profile")

export function assertTestPath(value: string) {
  const rel = relative(testRoot, resolve(value))
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel))
    throw new Error(`Refusing a path outside the desktop test directory: ${value}`)
  return resolve(value)
}
