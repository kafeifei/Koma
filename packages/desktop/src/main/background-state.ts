import { existsSync } from "node:fs"
import { join } from "node:path"

const desktopStateNames = ["ai.opencode.desktop.dev", "ai.opencode.desktop.beta", "ai.opencode.desktop"]

export function backgroundStateCandidates(shellStateHome: string | undefined, appDataPath: string, isolated = false) {
  const stateHome = process.env.XDG_STATE_HOME
  if (isolated) return stateHome && existsSync(stateHome) ? [stateHome] : []
  return [...new Set([stateHome, shellStateHome, ...desktopStateNames.map((name) => join(appDataPath, name))])].filter(
    (candidate) => candidate === undefined || existsSync(candidate),
  )
}
