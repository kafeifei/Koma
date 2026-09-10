import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "opencode"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("an explicit root replaces every ambient storage path without creating directories", async () => {
    const root = path.join(os.tmpdir(), `opencode-profile-${crypto.randomUUID()}`)
    const config = Global.make({ root })

    expect(config).toEqual({ home: Global.Path.home, ...StoragePaths.profile(root) })
    expect(
      await fs.access(root).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test("an explicit root rejects conflicting or unset persistent paths", () => {
    const root = path.join(os.tmpdir(), "opencode-profile")
    const profile = StoragePaths.profile(root)
    for (const key of Object.keys(profile) as (keyof typeof profile)[]) {
      if (key === "root" || key === "tmp") continue
      expect(() => Global.make({ root, [key]: path.join(root, "other") })).toThrow(`storage ${key} must match`)
      expect(() => Global.make({ root, [key]: undefined })).toThrow(`storage ${key} must match`)
    }
  })

  test("an explicit root accepts equivalent paths and explicit home and temporary directories", () => {
    const root = path.join(os.tmpdir(), "opencode-profile")
    const home = path.join(os.tmpdir(), "opencode-profile-home")
    const tmp = path.join(os.tmpdir(), "opencode-profile-tmp")
    expect(Global.make({ root, data: path.join(root, "child", "..", "data"), home, tmp })).toEqual({
      ...StoragePaths.profile(root),
      home,
      tmp,
    })
  })

  test("a data override rederives data paths and drops the ambient Lab identity", () => {
    const data = path.join(os.tmpdir(), "opencode-data-override")
    const config = Global.make({ data })
    expect(config).toMatchObject({
      data,
      root: undefined,
      desktop: undefined,
      codex: undefined,
      log: path.join(data, "log"),
      repos: path.join(data, "repos"),
      worktree: path.join(data, "worktree"),
      snapshot: path.join(data, "snapshot"),
    })
    expect(config.cache).toBe(Global.make().cache)
    expect(config.config).toBe(Global.make().config)
    expect(config.state).toBe(Global.make().state)
  })

  test("partial upstream overrides retain explicit paths and rederive only affected defaults", () => {
    const root = path.join(os.tmpdir(), "opencode-overrides")
    const data = path.join(root, "data")
    const cache = path.join(root, "cache")
    const snapshot = path.join(root, "snapshots")
    const config = Global.make({ data, cache, snapshot, config: path.join(root, "config") })
    expect(config.snapshot).toBe(snapshot)
    expect(config.config).toBe(path.join(root, "config"))
    expect(config.bin).toBe(path.join(cache, "bin"))
    expect(Global.make({ cache, bin: path.join(root, "bin") }).bin).toBe(path.join(root, "bin"))
    expect(Global.make({ data: Global.Path.data })).toEqual(Global.make())
  })
})
