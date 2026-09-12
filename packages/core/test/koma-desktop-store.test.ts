import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKomaDesktopStore } from "../src/koma-desktop-store"
import { createDesktopStorage } from "../../app/src/desktop/storage"
import { createKomaDraftStore } from "../src/koma-draft-store"
import { Database } from "bun:sqlite"

const paths: string[] = []
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "koma-desktop-store-"))
  paths.push(directory)
  return { directory, first: createKomaDesktopStore(directory), second: createKomaDesktopStore(directory) }
}
const name = "opencode.global.dat"

test("simultaneous hosts preserve separate settings and project additions", async () => {
  const { first, second, directory } = await fixture()
  const base = JSON.stringify({ sidebar: { width: 240 }, projects: [{ worktree: "/a", expanded: true }] })
  await first({ op: "set", name, key: "layout", value: base })
  await Promise.all([
    first({
      op: "set",
      name,
      key: "layout",
      base,
      value: JSON.stringify({
        sidebar: { width: 320 },
        projects: [
          { worktree: "/a", expanded: true },
          { worktree: "/b", expanded: true },
        ],
      }),
    }),
    second({
      op: "set",
      name,
      key: "layout",
      base,
      value: JSON.stringify({
        sidebar: { width: 240 },
        projects: [
          { worktree: "/a", expanded: false },
          { worktree: "/c", expanded: true },
        ],
      }),
    }),
    second({ op: "set", name, key: "language", value: '{"locale":"zh"}' }),
  ])
  const value = JSON.parse((await first({ op: "get", name, key: "layout" })) as string)
  expect(value.sidebar.width).toBe(320)
  expect(value.projects).toContainEqual({ worktree: "/a", expanded: false })
  expect(value.projects.map((item: any) => item.worktree).sort()).toEqual(["/a", "/b", "/c"])
  expect(JSON.parse(await readFile(join(directory, name), "utf8")).language).toBe('{"locale":"zh"}')
})

test("renderer changes propagate between hosts and queued edits retain external changes", async () => {
  const { first, second } = await fixture()
  const a = createDesktopStorage(first, 10)
  const b = createDesktopStorage(second, 10)
  try {
    const changed = Promise.withResolvers<string | null>()
    b.observeStorage(name, ({ key, newValue }) => {
      if (key === "language" && newValue) changed.resolve(newValue)
    })
    await a.storage(name).setItem("language", '{"locale":"zh"}')
    expect(await Promise.race([changed.promise, Bun.sleep(1000).then(() => "timeout")])).toBe('{"locale":"zh"}')
    await a.storage(name).setItem("layout", '{"width":240,"theme":"light"}')
    await b.storage(name).getItem("layout")
    await a.storage(name).setItem("layout", '{"width":320,"theme":"light"}')
    await Promise.all([
      b.storage(name).setItem("layout", '{"width":240,"theme":"dark"}'),
      b.storage(name).setItem("layout", '{"width":240,"theme":"system"}'),
    ])
    expect(JSON.parse((await a.storage(name).getItem("layout")) as string)).toEqual({ width: 320, theme: "system" })
  } finally {
    a.dispose()
    b.dispose()
  }
})

test("renderer API cannot access native credentials or paths outside the preference directory", async () => {
  const { first } = await fixture()
  for (const name of ["../auth.json", "opencode.settings.dat", "/etc/passwd", "opencode.global.dat/../secret"]) {
    await expect(first({ op: "get", name, key: "secret" })).rejects.toThrow()
  }
})

test("both hosts read the same committed drafts and preserve in-flight attachment blobs", async () => {
  const { directory } = await fixture()
  const path = join(directory, "drafts.sqlite")
  const a = createKomaDraftStore(new Database(path))
  const id = a.putBlob(new TextEncoder().encode("pending attachment"))
  const b = createKomaDraftStore(new Database(path))
  try {
    expect(b.getBlob(id)).toEqual(new TextEncoder().encode("pending attachment"))
    a.set("prompt:task", "unsent text")
    expect(b.get("prompt:task")).toBe("unsent text")
    b.set("prompt:task", "edited from Tauri")
    expect(a.get("prompt:task")).toBe("edited from Tauri")
  } finally {
    a.close()
    b.close()
  }
})
