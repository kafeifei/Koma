import { createEffect, on, onCleanup } from "solid-js"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { usePlatform } from "../context/platform"

/** Share the selected theme while each host draws its own native frame. */
export function DesktopTheme() {
  const platform = usePlatform()
  const theme = useTheme()
  if (platform.platform !== "desktop" || !platform.storage) return null
  const storage = platform.storage("opencode.global.dat")
  const key = "desktop.theme"
  let ready = false
  let disposed = false
  let last: string | null = null
  const current = () => JSON.stringify({ id: theme.themeId(), scheme: theme.colorScheme() })
  const apply = (value: string | null) => {
    if (!value || value === last || disposed) return
    try {
      const next = JSON.parse(value)
      if (typeof next.id !== "string" || !["system", "light", "dark"].includes(next.scheme)) return
      last = value
      theme.setTheme(next.id)
      theme.setColorScheme(next.scheme as ColorScheme)
    } catch (error) {
      console.warn("Invalid desktop theme preference", error)
    }
  }
  const unsubscribe = platform.observeStorage?.("opencode.global.dat", (change) => {
    if (change.key === key) apply(change.newValue)
  })
  onCleanup(() => {
    disposed = true
    unsubscribe?.()
  })
  void Promise.resolve(storage.getItem(key))
    .then(async (saved) => {
      if (disposed) return
      if (saved) apply(saved)
      else {
        last = current()
        await storage.setItem(key, last)
      }
      ready = true
    })
    .catch(console.error)
  createEffect(
    on([theme.themeId, theme.colorScheme], () => {
      if (!ready || disposed) return
      const value = current()
      if (value === last) return
      last = value
      void storage.setItem(key, value)
    }),
  )
  return null
}
