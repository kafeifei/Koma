import { makeEventListener } from "@solid-primitives/event-listener"

/**
 * Koma: while a session menu is open, one letter picks its item, as the menu's shortcut column shows: P pins, R
 * renames, A archives, D deletes. An item opts in with `data-menu-key`. Lives for the owner's lifetime.
 */
export function createMenuLetterKeys() {
  makeEventListener(
    document,
    "keydown",
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return

      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      )
        return

      if (!/^[a-z]$/i.test(event.key)) return

      const item = document.querySelector<HTMLElement>(
        `[role="menu"] [data-menu-key="${event.key.toLowerCase()}"]:not([data-disabled])`,
      )

      if (!item) return
      event.preventDefault()
      event.stopPropagation()
      // Kobalte commits a menu selection on pointerup; click() only moves its selection.
      item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
    },
    { capture: true },
  )
}
