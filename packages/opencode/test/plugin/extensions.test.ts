import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { readStore, updateStore } from "../../src/koma/extensions/store"
import { installPlugin, changePlugin, listPlugins, observe } from "../../src/koma/extensions/plugins"

describe("Koma extension registry", () => {
  test("serializes concurrent edits without losing plugins or project connections", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "extensions.json")
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        updateStore(
          (s) => ({
            ...s,
            plugins: [...s.plugins, { id: `plugin-${i}`, spec: `plugin-${i}@1.0.0`, enabled: false, options: {} }],
          }),
          file,
        ),
      ),
    )
    expect((await readStore(file)).plugins).toHaveLength(8)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  test("refuses to overwrite invalid persisted state", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "extensions.json")
    await fs.writeFile(file, "{broken")
    const failure = await updateStore((s) => s, file).then(
      () => null,
      (error) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(await fs.readFile(file, "utf8")).toBe("{broken")
  })

  test("install does not execute local code; disable and uninstall retain honest runtime state", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "plugin.mjs")
    const marker = path.join(dir.path, "executed")
    await fs.writeFile(
      file,
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); export default async () => ({})`,
    )
    const previous = await readStore()
    const runtime = observe(dir.path)
    try {
      await installPlugin({ spec: file, options: { test: true } })
      expect(await fs.exists(marker)).toBe(false)
      const rows = await listPlugins()
      const installed = rows.find((p) => p.spec.includes(dir.path))!
      expect(installed).toMatchObject({ installed: true, enabled: true, pending: true })
      runtime.set(installed.spec, true, { test: true }, "active")
      expect((await listPlugins()).find((p) => p.id === installed.id)?.pending).toBe(false)
      await changePlugin(installed.id, { enabled: false })
      expect((await listPlugins()).find((p) => p.id === installed.id)).toMatchObject({ enabled: false, pending: true })
      await changePlugin(installed.id)
      expect((await listPlugins()).find((p) => p.id === installed.id)).toMatchObject({
        installed: false,
        pending: true,
      })
      expect(await fs.exists(file)).toBe(true)
      runtime.dispose()
      expect((await listPlugins()).some((p) => p.id === installed.id)).toBe(false)
    } finally {
      runtime.dispose()
      await updateStore(() => previous)
    }
  })

  test("rejects a TUI-only package without adding a registry entry", async () => {
    await using dir = await tmpdir()
    await fs.writeFile(
      path.join(dir.path, "package.json"),
      JSON.stringify({ name: "tui-only", exports: { "./tui": "./tui.js" } }),
    )
    await fs.writeFile(path.join(dir.path, "tui.js"), "export default {}")
    const before = await readStore()
    const failure = await installPlugin({ spec: dir.path, options: {} }).then(
      () => null,
      (error) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(await readStore()).toEqual(before)
  })
})
