import type { Platform } from "../context/platform"
import { ServerConnection } from "../context/server"

/** Persist host preferences alongside the shared renderer preferences. */
export function installDesktopPreferences(platform: Platform) {
  const storage = platform.storage!("opencode.global.dat")
  const original = {
    getServer: platform.getDefaultServer,
    getPinch: platform.getPinchZoomEnabled,
    setPinch: platform.setPinchZoomEnabled,
  }
  platform.getDefaultServer = async () => {
    const saved = await storage.getItem("desktop.defaultServer")
    if (saved !== null) return saved ? ServerConnection.Key.make(saved) : null
    const legacy = (await original.getServer?.()) ?? null
    if (legacy) await storage.setItem("desktop.defaultServer", legacy)
    return legacy
  }
  platform.setDefaultServer = async (server) => {
    await storage.setItem("desktop.defaultServer", server ?? "")
  }
  platform.getPinchZoomEnabled = async () => {
    const saved = await storage.getItem("desktop.pinchZoom")
    if (saved !== null) return saved === "true"
    const legacy = (await original.getPinch?.()) ?? false
    await storage.setItem("desktop.pinchZoom", String(legacy))
    return legacy
  }
  platform.setPinchZoomEnabled = async (enabled) => {
    await original.setPinch?.(enabled)
    await storage.setItem("desktop.pinchZoom", String(enabled))
  }
  void Promise.resolve(platform.getPinchZoomEnabled())
    .then((enabled) => original.setPinch?.(enabled))
    .catch(console.error)
  return (
    platform.observeStorage?.("opencode.global.dat", ({ key, newValue }) => {
      if (key === "desktop.pinchZoom") void original.setPinch?.(newValue === "true")
    }) ?? (() => {})
  )
}
