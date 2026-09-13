import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createCatalogService, parseCatalog, catalogSources } from "../../src/koma/extensions/catalog"
import snapshot from "../../src/koma/extensions/catalog.snapshot.json"
import { tmpdir } from "../fixture/fixture"

test("official directory keeps duplicate names distinct and only maps reviewed project URLs", () => {
  const entries = parseCatalog(snapshot.ecosystem, snapshot.mcp)
  expect(entries.filter((e) => e.name === "opencode.nvim")).toHaveLength(2)
  expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length)
  expect(entries.find((e) => e.name === "opencode-md-table-formatter")?.plugin?.spec).toBe(
    "@franlol/opencode-md-table-formatter",
  )
  expect(entries.find((e) => e.name === "opencode-background-agents")?.installation?.type).toBe("files")
  expect(entries.find((e) => e.name === "opencode-shell-strategy")?.installation?.type).toBe("instructions")
  expect(entries.find((e) => e.name === "opencode-openai-codex-auth")?.installation?.type).toBe("builtin")
  expect(entries.find((e) => e.name === "opencode-type-inject")?.plugin?.spec).toBe("@nick-vi/opencode-type-inject")
  expect(entries.filter((e) => e.kind === "plugin" && !e.installation)).toEqual([])
  expect(entries.find((e) => e.name === "opencode-md-table-formatter")?.descriptionZh).toContain("表格")
  const spoofed = snapshot.ecosystem.replace(
    "https://github.com/angristan/opencode-wakatime",
    "https://example.com/opencode-wakatime",
  )
  expect(parseCatalog(spoofed, snapshot.mcp).find((e) => e.name === "opencode-wakatime")?.plugin).toBeUndefined()
  expect(parseCatalog(spoofed, snapshot.mcp).find((e) => e.name === "opencode-wakatime")?.installation).toBeUndefined()
})

test("MCP examples supply remote connection templates without importing commands or credentials", () => {
  const entries = parseCatalog(snapshot.ecosystem, snapshot.mcp)
  expect(entries.find((e) => e.id === "mcp:sentry")?.mcp).toEqual({
    name: "sentry",
    url: "https://mcp.sentry.dev/mcp",
    oauth: true,
  })
  expect(entries.find((e) => e.id === "mcp:context7")?.mcp).toEqual({
    name: "context7",
    url: "https://mcp.context7.com/mcp",
    oauth: false,
  })
  const injected = snapshot.mcp.replace(
    '"url": "https://mcp.context7.com/mcp"',
    '"url": "https://mcp.context7.com/mcp", "headers": {"Authorization": "secret"}, "command": ["bad"]',
  )
  expect(JSON.stringify(parseCatalog(snapshot.ecosystem, injected).filter((e) => e.mcp))).not.toContain("secret")
  expect(entries.filter((e) => e.mcp)).toHaveLength(3)
})

test("rejects invalid source URLs and incomplete documentation", () => {
  expect(() =>
    parseCatalog(
      snapshot.ecosystem.replace("https://github.com/angristan/opencode-wakatime", "javascript:alert(1)"),
      snapshot.mcp,
    ),
  ).toThrow()
  expect(() => parseCatalog(snapshot.ecosystem, "<html>error</html>")).toThrow()
  expect(() => parseCatalog(snapshot.ecosystem, "a".repeat(600_000))).toThrow()
})

test("first launch works offline; refresh only requests fixed public sources and persists a reusable cache", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "cache.json")
  const requests: { url: string; options: RequestInit }[] = []
  const service = createCatalogService(file, async (url, options) => {
    requests.push({ url, options })
    return new Response(url === catalogSources.ecosystem ? snapshot.ecosystem : snapshot.mcp)
  })
  const first = await service.get()
  expect(first.origin).toBe("bundled")
  expect(requests).toHaveLength(0)
  expect((await service.refresh()).origin).toBe("remote")
  expect(requests.map((r) => r.url).sort()).toEqual(Object.values(catalogSources).sort())
  expect(requests.every((r) => r.options.headers === undefined && r.options.redirect === "error")).toBe(true)
  const offline = createCatalogService(file, async () => {
    throw new Error("offline")
  })
  expect((await offline.get()).origin).toBe("cache")
  const before = await fs.readFile(file, "utf8")
  const failed = await offline.refresh()
  expect(failed.warning).toBe("offline")
  expect(failed.entries).toEqual(first.entries)
  expect(await fs.readFile(file, "utf8")).toBe(before)
})

test("a bad response cannot replace good cache, and a corrupt cache falls back to bundled resources", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "cache.json")
  await fs.writeFile(file, JSON.stringify(snapshot))
  const before = await fs.readFile(file, "utf8")
  const service = createCatalogService(file, async () => new Response("upstream format changed"))
  expect((await service.refresh()).warning).toBeDefined()
  expect(await fs.readFile(file, "utf8")).toBe(before)
  await fs.writeFile(file, "{")
  expect((await service.get()).origin).toBe("bundled")
})
