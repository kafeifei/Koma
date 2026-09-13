import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { prepareFiles, installCatalogEntry } from "../../src/koma/extensions/install"
import { recipes, type FileRecipe } from "../../src/koma/extensions/recipes"
import { readStore } from "../../src/koma/extensions/store"
import { tmpdir } from "../fixture/fixture"

function fixture(text: string): FileRecipe {
  return {
    type: "files",
    version: "test",
    verifiedAt: "2026-09-13",
    entry: null,
    files: [
      {
        path: "rules/shell.md",
        url: "https://raw.githubusercontent.com/owner/repo/commit/shell.md",
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ],
    dependencies: {},
    instructions: ["rules/shell.md"],
  }
}

test("imports a local rule through native config and preserves existing instructions", async () => {
  await using dir = await tmpdir()
  const prepared = await prepareFiles(fixture("Example instructions"), dir.path, async (_url, options) => {
    expect(options?.redirect).toBe("error")
    expect(options?.headers).toBeUndefined()
    return new Response("Example instructions")
  })
  const module = await import(pathToFileURL(prepared.entry).href)
  const hook = await module.KomaResourceConfiguration()
  const config = { instructions: ["existing.md"] }
  await hook.config(config)
  await hook.config(config)
  expect(config.instructions).toEqual(["existing.md", path.join(prepared.directory, "rules/shell.md")])
  expect(await fs.readFile(config.instructions[1], "utf8")).toBe("Example instructions")
})

test("hash mismatch and failed downloads remove incomplete files without invoking dependency installation", async () => {
  await using dir = await tmpdir()
  let installs = 0
  const deps = async () => {
    installs++
  }
  await expect(prepareFiles(fixture("expected"), dir.path, async () => new Response("changed"), deps)).rejects.toThrow(
    "integrity",
  )
  expect(await fs.readdir(dir.path)).toEqual([])
  await expect(
    prepareFiles(fixture("expected"), dir.path, async () => new Response("offline", { status: 503 }), deps),
  ).rejects.toThrow("503")
  expect(await fs.readdir(dir.path)).toEqual([])
  expect(installs).toBe(0)
})

test("preparation preserves source file layout and does not execute plugin code", async () => {
  await using dir = await tmpdir()
  const marker = path.join(dir.path, "executed")
  const text = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); export default async () => ({})`
  const recipe = fixture(text)
  recipe.files[0].path = "plugins/main.mjs"
  recipe.entry = "plugins/main.mjs"
  recipe.defaultExport = true
  recipe.instructions = []
  const prepared = await prepareFiles(recipe, dir.path, async () => new Response(text))
  expect(await fs.exists(marker)).toBe(false)
  expect(await fs.readFile(path.join(prepared.directory, recipe.entry), "utf8")).toBe(text)
  expect(await fs.readFile(prepared.entry, "utf8")).toContain('export { default } from "./plugins/main.mjs"')
})

test("rejects traversal, missing entries, reserved files, and unknown catalog IDs", async () => {
  await using dir = await tmpdir()
  for (const file of ["../outside", "/tmp/outside", "plugins/../../outside", "package.json", "koma-entry.mjs"]) {
    const recipe = fixture("text")
    recipe.files[0].path = file
    await expect(prepareFiles(recipe, dir.path)).rejects.toThrow()
  }
  const recipe = fixture("text")
  recipe.entry = "missing.js"
  await expect(prepareFiles(recipe, dir.path)).rejects.toThrow("missing")
  const before = await readStore()
  await expect(installCatalogEntry("plugin:https://example.com/untrusted")).rejects.toThrow("not available")
  expect(await readStore()).toEqual(before)
  expect(await fs.readdir(dir.path)).toEqual([])
})

test("source recipes use immutable upstream commits and checked file digests", () => {
  for (const recipe of Object.values(recipes)) {
    if (recipe.type !== "files") continue
    expect(recipe.files.length).toBeGreaterThan(0)
    for (const file of recipe.files) {
      expect(file.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//)
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  }
})
