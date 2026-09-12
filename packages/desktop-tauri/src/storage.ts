import type { Platform } from "@opencode-ai/app"

// Task/config/history data is served by Koma. Only this window's UI preferences
// use WebKit storage, initially reading Electron's display preferences without
// writing its live electron-store files or importing the former fixture profile.
export function desktopStorage(
  profile: string,
  seed: Record<string, Record<string, string>>,
): NonNullable<Platform["storage"]> {
  return (name = "default.dat") => {
    const prefix = `koma-tauri:${profile}:${name}:`
    const initial = seed[name] ?? {}
    const keys = () =>
      [
        ...new Set([
          ...Object.keys(initial),
          ...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length)),
        ]),
      ].filter((key) => getItem(key) !== null)
    const getItem = (key: string): string | null => {
      const value = localStorage.getItem(prefix + key)
      return value === null ? (initial[key] ?? null) : JSON.parse(value)
    }
    return {
      getItem,
      setItem: (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value)),
      removeItem: (key) => localStorage.setItem(prefix + key, "null"),
      clear: () => keys().forEach((key) => localStorage.setItem(prefix + key, "null")),
      key: (index: number) => keys()[index] ?? null,
      get length() {
        return keys().length
      },
    }
  }
}
