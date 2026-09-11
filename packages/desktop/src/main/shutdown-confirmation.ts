import type { MessageBoxOptions } from "electron"
import type { ServerReadyData } from "../preload/types"
import { nativeT } from "./native-translations"

export async function confirmBackendShutdown(input: {
  backend(): Promise<ServerReadyData | undefined>
  showDialog(options: MessageBoxOptions): Promise<{ response: number }>
  warn(error: unknown): void
  fetch?: typeof fetch
  timeoutMs?: number
}) {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const inspect = async () => {
    const backend = await input.backend()
    if (abort.signal.aborted) throw new Error("Lab shutdown status check timed out")
    // A desktop connected only to a remote server has no local Lab backend to stop.
    if (!backend) return false
    const response = await (input.fetch ?? fetch)(new URL("/lab/shutdown-state", backend.url), {
      headers:
        backend.username && backend.password
          ? { Authorization: `Basic ${Buffer.from(`${backend.username}:${backend.password}`).toString("base64")}` }
          : {},
      signal: abort.signal,
    })
    if (!response.ok) throw new Error(`Lab shutdown status request failed (${response.status})`)
    const value: unknown = await response.json()
    if (!value || typeof value !== "object" || !("active" in value) || typeof value.active !== "boolean")
      throw new Error("Lab shutdown status response is invalid")
    return value.active
  }
  // Bound startup as well as HTTP I/O. The timer ends before the user is asked;
  // waiting at the confirmation dialog must never trigger automatic shutdown.
  const active = await Promise.race([
    inspect(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort()
        reject(new Error("Lab shutdown status check timed out"))
      }, input.timeoutMs ?? 4_000)
    }),
  ])
    .catch((error) => {
      input.warn(error)
      return undefined
    })
    .finally(() => clearTimeout(timer))
  if (active === false) return true
  const unknown = active === undefined
  const result = await input.showDialog({
    type: "warning",
    title: nativeT("desktop.shutdown.title"),
    message: nativeT(unknown ? "desktop.shutdown.unknown.message" : "desktop.shutdown.active.message"),
    detail: nativeT(unknown ? "desktop.shutdown.unknown.detail" : "desktop.shutdown.active.detail"),
    buttons: [
      nativeT("desktop.shutdown.cancel"),
      nativeT(unknown ? "desktop.shutdown.quitAnyway" : "desktop.shutdown.stopAndQuit"),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return result.response === 1
}
