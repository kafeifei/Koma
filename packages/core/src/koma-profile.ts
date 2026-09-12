import { existsSync, lstatSync, realpathSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, normalize } from "node:path"
import { StoragePaths } from "./storage-paths"

/** Keep old task paths and process locks authoritative while exposing the Koma home. */
export function resolveHome(environment: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const explicit = environment.KOMA_HOME ?? environment.OPENCODE_HOME
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new Error("KOMA_HOME must be an absolute path")
    return canonicalHome(explicit)
  }
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

export function isDefault(root: string, home = homedir()) {
  return [join(home, ".koma"), join(home, ".opencode")].some(
    (path) => (existsSync(path) ? realpathSync(path) : path) === root,
  )
}

export * as KomaProfile from "./koma-profile"

function canonicalHome(value: string): string {
  const normalized = normalize(value)
  if (existsSync(normalized)) return realpathSync(normalized)
  return join(canonicalHome(dirname(normalized)), basename(normalized))
}
