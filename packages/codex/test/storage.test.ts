import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexStorage } from "../src/storage"

test("moving the native home keeps the durable Codex scope while retaining explicit overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-codex-storage-"))
  try {
    const legacy = codexStorage({ state: join(root, "legacy", "state") })
    const target = join(root, "unified")
    await mkdir(target)
    await writeFile(
      join(target, "storage.json"),
      JSON.stringify({
        version: 1,
        source: join(root, "legacy"),
        status: "complete",
        database: "opencode-lab.db",
        codexScope: legacy.scope,
      }),
    )
    const migrated = codexStorage({ state: join(target, "state"), root: target })
    expect(migrated.home).toBe(join(target, "engines", "codex"))
    expect(migrated.scope).toBe(legacy.scope)
    expect(codexStorage({ state: join(target, "state"), root: target, home: migrated.home })).toEqual(migrated)

    const alternate = join(root, "other-codex")
    expect(codexStorage({ state: join(target, "state"), root: target, home: alternate })).toEqual(
      codexStorage({ state: root, home: alternate }),
    )
    expect(codexStorage({ state: root, home: alternate }).scope).not.toBe(legacy.scope)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
