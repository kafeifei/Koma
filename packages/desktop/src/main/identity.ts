import path from "node:path"
import { KOMA } from "./koma"

export type Channel = "local" | "dev" | "beta" | "prod"

// Koma: packaged builds carry Koma's identity (`koma.ts`); only the unpackaged dev run keeps upstream's.
const appNames: Record<Channel, string> = {
  local: "OpenCode Dev",
  dev: KOMA.dev.appName,
  beta: KOMA.beta.appName,
  prod: KOMA.prod.appName,
}

const appIDs: Record<Channel, string> = {
  local: "ai.opencode.desktop.dev",
  dev: KOMA.dev.appID,
  beta: KOMA.beta.appID,
  prod: KOMA.prod.appID,
}

// Unpackaged dev runs keep the dev profile directory (`appID`), but use a separate Windows
// AppUserModelID: Electron writes a Start Menu `Electron.lnk` with the active AUMID on the first
// toast, which would otherwise shadow the installed OpenCode Dev shortcut and route its toast
// clicks to bare `electron.exe`.
const LOCAL_APP_USER_MODEL_ID = "ai.opencode.desktop.local"

export function resolveIdentity(channel: Channel, packaged: boolean) {
  return {
    appName: packaged ? appNames[channel] : "OpenCode Dev",
    appID: packaged ? appIDs[channel] : "ai.opencode.desktop.dev",
    appUserModelID: packaged ? appIDs[channel] : LOCAL_APP_USER_MODEL_ID,
  }
}

export function isCollidingDevShortcut(
  shortcut: { readonly appUserModelId?: string; readonly target: string },
  appUserModelID: string,
  execPath: string,
) {
  if (!shortcut.appUserModelId) return false

  if (shortcut.appUserModelId.toLowerCase() !== appUserModelID.toLowerCase()) return false

  return path.win32.normalize(shortcut.target).toLowerCase() !== path.win32.normalize(execPath).toLowerCase()
}
