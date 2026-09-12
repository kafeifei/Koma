import { readFile } from "@tauri-apps/plugin-fs"
import { open, save } from "@tauri-apps/plugin-dialog"
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener"
import type { Platform } from "@opencode-ai/app"
import { desktopDebugTools } from "@opencode-ai/app/build-info"
import { invoke } from "@tauri-apps/api/core"
import { readImage } from "@tauri-apps/plugin-clipboard-manager"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { windowFullscreen } from "./window-state"

const attachmentPaths = new WeakMap<File, string>()
const notifications = new Map<string, () => void>()
void getCurrentWindow()
  .listen<{ id: string; clicked: boolean }>("notification-response", ({ payload }) => {
    const callback = notifications.get(payload.id)
    notifications.delete(payload.id)
    if (payload.clicked) callback?.()
  })
  .catch(console.error)

export const platform: Platform = {
  platform: "desktop",
  os: "macos",
  version: import.meta.env.OPENCODE_BUILD.version,
  buildInfo: import.meta.env.OPENCODE_BUILD,
  debugTools: desktopDebugTools(import.meta.env.OPENCODE_BUILD),
  checkAppExists: (appName) => invoke("check_app_exists", { appName }),
  exportDebugLogs: async () => {
    const path = await invoke<string>("export_debug_logs")
    await revealItemInDir(path)
    return path
  },
  readClipboardImage: async () => {
    const image = await readImage().catch(() => null)
    if (!image) return null
    try {
      const { width, height } = await image.size()
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      canvas
        .getContext("2d")!
        .putImageData(new ImageData(new Uint8ClampedArray(await image.rgba()), width, height), 0, 0)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
      return blob ? new File([blob], `pasted-image-${Date.now()}.png`, { type: "image/png" }) : null
    } finally {
      await image.close()
    }
  },
  windowID: `koma-tauri-${getCurrentWindow().label}`,
  windowFullscreen,
  openDirectoryPickerDialog: (options) =>
    open({ directory: true, multiple: options?.multiple ?? false, title: options?.title }),
  openAttachmentPickerDialog: async (options, onFile) => {
    const extensions = options.extensions?.map((value) => value.replace(/^\./, ""))
    const selected = await open({
      title: options.title,
      multiple: options.multiple ?? true,
      defaultPath: options.defaultPath,
      filters: extensions?.length ? [{ name: "Files", extensions }] : undefined,
    })
    for (const path of typeof selected === "string" ? [selected] : (selected ?? [])) {
      const file = new File([await readFile(path)], path.split("/").at(-1) ?? path)
      attachmentPaths.set(file, path)
      await onFile(file)
    }
  },
  getPathForFile: (file) => attachmentPaths.get(file) ?? "",
  openLocalFile: (url) => {
    const parsed = new URL(url)
    if (parsed.protocol === "file:") void openPath(decodeURIComponent(parsed.pathname))
  },
  saveFilePickerDialog: (options) => save({ title: options?.title, defaultPath: options?.defaultPath }),
  openExternal: (value) => {
    if (!URL.canParse(value)) return
    if (!["https:", "http:", "mailto:"].includes(new URL(value).protocol)) return
    void openUrl(value)
  },
  openPath: (path, app) => openPath(path, app),
  revealPath: async (path) => {
    await revealItemInDir(path)
    return true
  },
  restart: async () => window.location.reload(),
  notify: async (title, description, onClick) => {
    if (await getCurrentWindow().isFocused()) return
    const id = crypto.randomUUID()
    if (onClick) notifications.set(id, onClick)
    try {
      await invoke("notify_user", { title, body: description ?? "", id })
    } catch (error) {
      notifications.delete(id)
      throw error
    }
  },
}
