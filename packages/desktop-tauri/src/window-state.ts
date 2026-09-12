import { createSignal } from "solid-js"
import { getCurrentWindow } from "@tauri-apps/api/window"

const [windowFullscreen, setWindowFullscreen] = createSignal(false)
export { windowFullscreen }

export function watchWindowState() {
  const window = getCurrentWindow()
  let disposed = false
  let unlisten: (() => void) | undefined
  const update = async () => {
    const fullscreen = await window.isFullscreen()
    if (!disposed) setWindowFullscreen(fullscreen)
  }
  void window
    .onResized(() => void update().catch(console.error))
    .then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })
    .catch(console.error)
  void update().catch(console.error)
  return () => {
    disposed = true
    unlisten?.()
  }
}
