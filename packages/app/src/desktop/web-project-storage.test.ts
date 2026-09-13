import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SyncStorage } from "@solid-primitives/storage"
import { createKomaDesktopStore } from "@opencode-ai/core/koma-desktop-store"
import { createWebProjectStorage } from "./web-project-storage"

const name = "opencode.global.dat"
const key = "server"
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "koma-web-projects-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const call = createKomaDesktopStore(directory)
  const local = new Map<string, SyncStorage>()
  const browser = (name = "direct") => {
    if (!local.has(name)) {
      const values = new Map<string, string>()
      local.set(name, {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value)
        },
        removeItem: (key) => {
          values.delete(key)
        },
      })
    }
    return local.get(name)!
  }
  const desktop = {
    list: [{ type: "http", http: { url: "http://127.0.0.1:12345" } }],
    projects: { local: [{ worktree: "/desktop", expanded: true }], remote: [{ worktree: "/remote" }] },
    lastProject: { local: "/desktop", remote: "/remote" },
    recentlyClosed: { local: ["/closed"] },
  }
  const put = (value: unknown) => call({ op: "set", name, key, value: JSON.stringify(value) })
  const get = async () => JSON.parse((await call({ op: "get", name, key })) as string)
  await put(desktop)
  const web = await createWebProjectStorage(call, browser, 20)
  cleanup.push(web.dispose)
  return { web, browser, desktop, put, get, storage: web.storage(name) }
}

test("a fresh browser sees desktop projects without inheriting desktop connections or window state", async () => {
  const { web, storage, browser } = await setup()
  const value = JSON.parse((await storage.getItem(key))!)
  expect(value.projects).toEqual({ local: [{ worktree: "/desktop", expanded: true }] })
  expect(value.lastProject).toEqual({ local: "/desktop" })
  expect(value.recentlyClosed).toEqual({ local: ["/closed"] })
  expect(value.list).toBeUndefined()
  await storage.setItem("preferences", "browser preferences")
  expect(browser(name).getItem("preferences")).toBe("browser preferences")
  expect(web.storage("opencode.window.browser.dat")).toBe(browser("opencode.window.browser.dat"))
  expect(web.storage("opencode.draft.test.dat")).toBe(browser("opencode.draft.test.dat"))
})

test("browser changes and concurrent desktop additions merge without overwriting either client's connections", async () => {
  const { storage, browser, desktop, put, get } = await setup()
  browser(name).setItem(key, JSON.stringify({ list: ["browser-server"], projects: { other: ["browser-remote"] } }))
  const value = JSON.parse((await storage.getItem(key))!)
  await put({
    ...desktop,
    list: ["new-desktop-server"],
    projects: { ...desktop.projects, local: [...desktop.projects.local, { worktree: "/concurrent", expanded: true }] },
  })
  value.projects.local.push({ worktree: "/web", expanded: true })
  await storage.setItem(key, JSON.stringify(value))
  const saved = await get()
  expect(saved.list).toEqual(["new-desktop-server"])
  expect(saved.projects.remote).toEqual(desktop.projects.remote)
  expect(saved.projects.local.map((p: any) => p.worktree)).toEqual(["/desktop", "/web", "/concurrent"])
  const merged = JSON.parse((await storage.getItem(key))!)
  expect(merged.list).toEqual(["browser-server"])
  expect(merged.projects.other).toEqual(["browser-remote"])
  merged.projects.local = merged.projects.local.filter((p: any) => p.worktree !== "/desktop")
  await storage.setItem(key, JSON.stringify(merged))
  expect((await get()).projects.local.map((p: any) => p.worktree)).toEqual(["/web", "/concurrent"])
})

test("an already open page receives desktop project changes", async () => {
  const { web, desktop, put } = await setup()
  const received = new Promise<string>((resolve) => {
    web.observeStorage(name, (change) => resolve(change.newValue!))
  })
  await put({ ...desktop, projects: { ...desktop.projects, local: [{ worktree: "/new", expanded: true }] } })
  const value = JSON.parse(await received)
  expect(value.projects.local).toEqual([{ worktree: "/new", expanded: true }])
  expect(value.list).toBeUndefined()
})

test("a non-desktop server can reject capability probing without modifying browser state", async () => {
  await expect(
    createWebProjectStorage(
      async () => {
        throw new Error("404")
      },
      () => {
        throw new Error("should not touch browser")
      },
    ),
  ).rejects.toThrow("404")
})
