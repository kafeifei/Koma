import { app } from "electron"
import { desktopIdentity, desktopUpdaterEnabled, resolveDesktopChannel } from "./channel"

export const CHANNEL = resolveDesktopChannel(import.meta.env.OPENCODE_CHANNEL)
export const APP_ID = desktopIdentity(CHANNEL, import.meta.env.OPENCODE_BUILD.release).appId
export const APP_NAME = desktopIdentity(CHANNEL, import.meta.env.OPENCODE_BUILD.release).name
export const APP_PROTOCOL = desktopIdentity(CHANNEL).scheme

export const UPDATER_ENABLED = desktopUpdaterEnabled(app.isPackaged, CHANNEL)
