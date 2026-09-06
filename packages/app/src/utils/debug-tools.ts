import type { Platform } from "@/context/platform"

export function debugToolsEnabled(platform: Pick<Platform, "debugTools">) {
  return (import.meta.env.DEV || platform.debugTools === true) && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1"
}
