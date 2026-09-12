import { existsSync, lstatSync, realpathSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, normalize } from "node:path"
import { StoragePaths } from "./storage-paths"

/** The installed CLI and desktop host set this from their build identity. */
export function isRelease(environment: NodeJS.ProcessEnv = process.env) {
  return environment.KOMA_DISTRIBUTION === "release"
}

export function commandName(environment: NodeJS.ProcessEnv = process.env) {
  return isRelease(environment) ? "koma" : "koma-debug"
}

export function releaseHome(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform = process.platform,
) {
  const base =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Koma")
      : platform === "win32"
        ? join(environment.APPDATA || join(home, "AppData", "Roaming"), "Koma")
        : join(environment.XDG_DATA_HOME || join(home, ".local", "share"), "koma")
  // Electron may create its own app-data directory before selecting userData.
  if (!isAbsolute(base)) throw new Error("Koma application data directory must be an absolute path")
  return canonicalHome(join(base, "profile"))
}

/** Release never discovers or aliases a developer profile. */
export function resolveHome(environment: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const explicit = environment.KOMA_HOME ?? environment.OPENCODE_HOME
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new Error("KOMA_HOME must be an absolute path")
    return canonicalHome(explicit)
  }
  if (isRelease(environment)) return releaseHome(environment, home)
  const current = join(home, ".koma")
  const legacy = join(home, ".opencode")
  // An official OpenCode directory is not a Koma profile. Only the Lab manifest opts in.
  const previous = existsSync(join(legacy, "storage.json")) ? StoragePaths.metadata(legacy) : undefined
  const entry = lstatSync(current, { throwIfNoEntry: false })
  if (entry) {
    const canonical = realpathSync(current)
    if (previous && canonical !== realpathSync(legacy)) {
      throw new Error("Both Koma and legacy Lab profiles exist; select one explicitly with KOMA_HOME")
    }
    return canonical
  }
  if (!previous) return current
  if (previous.status !== "complete") throw new Error("Finish the existing Lab storage migration before opening Koma")
  try {
    symlinkSync(legacy, current, "dir")
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
  }
  if (realpathSync(current) !== realpathSync(legacy)) throw new Error("Koma profile changed during compatibility setup")
  return realpathSync(legacy)
}

export function isDefault(root: string, home = homedir(), environment: NodeJS.ProcessEnv = process.env) {
  if (isRelease(environment)) return root === releaseHome(environment, home)
  return [join(home, ".koma"), join(home, ".opencode")].some(
    (path) => (existsSync(path) ? realpathSync(path) : path) === root,
  )
}

export function legacyRoot(root: string, previousDesktop: string, environment: NodeJS.ProcessEnv = process.env) {
  return !isRelease(environment) && isDefault(root, homedir(), environment) ? previousDesktop : `${root}.legacy`
}

/** Must run under the storage initialization lock, before any migration. */
export function assertReleaseHome(root: string, legacy: string) {
  if (lstatSync(legacy, { throwIfNoEntry: false }) || StoragePaths.metadata(root)?.source) {
    throw new Error("Koma release cannot automatically import a developer profile; choose a separate KOMA_HOME")
  }
}

export * as KomaProfile from "./koma-profile"

function canonicalHome(value: string): string {
  const normalized = normalize(value)
  if (existsSync(normalized)) return realpathSync(normalized)
  return join(canonicalHome(dirname(normalized)), basename(normalized))
}
