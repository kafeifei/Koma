/** Adapt the shared Electron titlebar's nested regions to Tauri 2's subtree semantics. */
export function watchTitlebarDragRegions() {
  const prepare = (event: MouseEvent) => {
    const path = event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement)
    if (!path.some((node) => node.dataset.slot === "titlebar-v2")) return
    for (const node of path) {
      const region = node.getAttribute("data-tauri-drag-region")
      if (region === "" || region === "true") node.setAttribute("data-tauri-drag-region", "deep")
    }
  }
  // Run before Tauri's document listener. Its native handler still owns dragging,
  // double-clicking and exclusions for buttons, tabs, inputs and explicit false regions.
  document.addEventListener("mousedown", prepare, true)
  document.addEventListener("mouseup", prepare, true)
  return () => {
    document.removeEventListener("mousedown", prepare, true)
    document.removeEventListener("mouseup", prepare, true)
  }
}
