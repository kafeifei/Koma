import { open, save } from "@tauri-apps/plugin-dialog"
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener"
import type { Platform } from "@opencode-ai/app"
import { ServerConnection } from "@opencode-ai/app"
import { createBrowserDraftStore } from "../../app/src/utils/draft-store"
import { windowFullscreen } from "./window-state"

export const platform: Platform = {
  platform: "desktop",
  os: "macos",
  version: import.meta.env.OPENCODE_BUILD.version,
  buildInfo: import.meta.env.OPENCODE_BUILD,
  debugTools: true,
  windowID: "tauri-test-main",
  windowFullscreen,
  draftStore: createBrowserDraftStore(),
  getDefaultServer: async () => ServerConnection.Key.make("sidecar"),
  openDirectoryPickerDialog: (options) =>
    open({ directory: true, multiple: options?.multiple ?? false, title: options?.title }),
  saveFilePickerDialog: (options) => save({ title: options?.title, defaultPath: options?.defaultPath }),
  openExternal: (value) => {
    if (!URL.canParse(value)) return
    if (!["https:", "http:", "mailto:"].includes(new URL(value).protocol)) return
    void openUrl(value)
  },
  openPath: (path) => openPath(path),
  revealPath: async (path) => {
    await revealItemInDir(path)
    return true
  },
  restart: async () => window.location.reload(),
  notify: async () => {},
}
