import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { confirmDesktopShutdown, type DesktopBackendConnection } from "@opencode-ai/app/desktop/shutdown"
import { createDesktopQuitState, createShutdownController } from "@opencode-ai/app/desktop/shutdown-controller"
import { DESKTOP_NATIVE_ENGLISH, type DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
import { DESKTOP_MENU, desktopMenuVisible, type DesktopMenuItem } from "@opencode-ai/app/desktop-menu"
import { createDesktopZoom } from "@opencode-ai/app/desktop/zoom"
import { platform } from "./platform"

export function installDesktopHost(connection: Promise<DesktopBackendConnection>) {
  const quitState = createDesktopQuitState()
  platform.onAppQuitting = quitState.subscribe
  let translations: DesktopNativeBundle = { locale: "en", messages: { ...DESKTOP_NATIVE_ENGLISH } }
  const commands = new Set<(id: string) => void>()
  const entries = new Map<string, DesktopMenuItem>()
  const shutdown = createShutdownController({
    confirm: () =>
      confirmDesktopShutdown({
        backend: () => connection,
        translate: (key) => translations.messages[key],
        warn: console.warn,
        showDialog: async (options) => ({ response: await invoke<number>("show_shutdown_dialog", { options }) }),
      }),
    stop: () => invoke("stop_backend"),
    quit: () => {
      void invoke("exit_app")
    },
    setQuitting: quitState.setQuitting,
    log: console.info,
    warn: console.warn,
  })
  const quit = async (restart = false) => {
    try {
      await shutdown.requestQuit(
        restart
          ? () => {
              void invoke("restart_app")
            }
          : undefined,
      )
    } finally {
      if (!shutdown.isQuitting()) await invoke("cancel_quit")
    }
  }
  void getCurrentWindow().listen("desktop-quit", () => {
    void quit().catch(console.error)
  })
  void getCurrentWindow().listen<string>("desktop-menu", ({ payload }) => {
    const item = entries.get(payload)
    if (item?.command) commands.forEach((callback) => callback(item.command!))
    else if (item?.action) void platform.runDesktopMenuAction?.(item.action)
    else if (item?.href) platform.openExternal(item.href)
  })
  platform.onMenuCommand = (callback) => {
    commands.add(callback)
    return () => {
      commands.delete(callback)
    }
  }
  platform.restart = () => quit(true)
  let zoom: ReturnType<typeof createDesktopZoom> | undefined
  const installStorage = () => {
    const storage = platform.storage!("opencode.global.dat")
    const callbacks = new Set<(enabled: boolean) => void>()
    zoom = createDesktopZoom({
      setZoomFactor: (factor) => invoke("set_zoom", { factor }),
      onZoomFactorChanged: () => {},
      getPinchZoomEnabled: async () => (await storage.getItem("desktop.pinchZoom")) === "true",
      setPinchZoomEnabled: async (enabled) => {
        await storage.setItem("desktop.pinchZoom", String(enabled))
        callbacks.forEach((cb) => cb(enabled))
      },
      onPinchZoomEnabledChanged: (callback) => {
        callbacks.add(callback)
      },
    })
    platform.webviewZoom = zoom.webviewZoom
    platform.getPinchZoomEnabled = async () => (await storage.getItem("desktop.pinchZoom")) === "true"
    platform.setPinchZoomEnabled = zoom.setPinchZoomEnabled
    platform.observeStorage?.("opencode.global.dat", ({ key, newValue }) => {
      if (key === "desktop.pinchZoom") callbacks.forEach((cb) => cb(newValue === "true"))
    })
  }
  platform.runDesktopMenuAction = async (action) => {
    if (action === "view.resetZoom") return zoom?.resetZoom()
    if (action === "view.zoomIn") return zoom?.zoomIn()
    if (action === "view.zoomOut") return zoom?.zoomOut()
    if (action === "app.relaunch") return quit(true)
    if (action === "view.reload") return window.location.reload()
    if (action.startsWith("edit.")) {
      document.execCommand(action.slice(5))
      return
    }
    await invoke("native_window_action", { action })
  }
  platform.setTitlebar = ({ mode, scheme }) => getCurrentWindow().setTheme(scheme === "system" ? null : mode)
  platform.setBackgroundColor = (color) => getCurrentWindow().setBackgroundColor(color)
  const setNativeTranslations = (bundle: DesktopNativeBundle) => {
    translations = bundle
    entries.clear()
    const menus = DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "macos")).map((menu) => ({
      ...menu,
      label: bundle.messages[menu.labelKey],
      items: menu.items
        ?.filter((item) => desktopMenuVisible(item, "macos"))
        .map((item, index) => {
          if (item.type === "item") entries.set(`${menu.id}:${index}`, item)
          return {
            ...item,
            label: item.type === "item" && item.labelKey ? bundle.messages[item.labelKey] : undefined,
            accelerator: item.type === "item" ? item.accelerator?.macos : undefined,
          }
        }),
    }))
    void invoke("set_desktop_menu", { menus }).catch(console.error)
  }
  return { setNativeTranslations, installStorage }
}
