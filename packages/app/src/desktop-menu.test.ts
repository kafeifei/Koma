import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"

describe("desktop menu", () => {
  test("routes Cmd+W through the app without a native close accelerator taking precedence", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter((item) => item.type === "item")
    const close = items.filter((item) => item.accelerator?.macos === "Cmd+W")

    expect(close).toHaveLength(1)
    expect(close[0]?.command).toBe("tab.close")
    expect(close[0]?.action).toBeUndefined()
    expect(items.some((item) => item.role === "close")).toBe(false)
    expect(items.some((item) => item.action === "window.close")).toBe(true)
  })

  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.labelKey === "desktop.menu.exportLogs",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("provides translated labels for role-backed entries", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.role === "windowMenu")
    const roleItems = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.role && item.labelKey,
    )

    expect(windowMenu?.labelKey).toBe("desktop.menu.window")
    expect(roleItems.length).toBeGreaterThan(0)
  })
})
