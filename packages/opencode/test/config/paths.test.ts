import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

test("shared storage does not scan the legacy home configuration directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-config-paths-"))
  roots.push(dir)
  const home = path.join(dir, "home")
  const shared = path.join(dir, "shared")
  const project = path.join(dir, "project")
  await Promise.all([
    fs.mkdir(path.join(home, ".opencode"), { recursive: true }),
    fs.mkdir(path.join(project, ".opencode"), { recursive: true }),
  ])

  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      [
        'const { ConfigPaths } = await import("./src/config/paths.ts")',
        'const { FSUtil } = await import("@opencode-ai/core/fs-util")',
        'const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")',
        'const { Effect } = await import("effect")',
        `const result = await Effect.runPromise(ConfigPaths.directories(${JSON.stringify(project)}).pipe(Effect.provide(LayerNode.compile(FSUtil.node))))`,
        "console.log(JSON.stringify(result))",
      ].join(";"),
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        HOME: home,
        OPENCODE_TEST_HOME: home,
        OPENCODE_HOME: shared,
        XDG_DATA_HOME: path.join(dir, "xdg-data"),
        XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
        XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
        XDG_STATE_HOME: path.join(dir, "xdg-state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual([path.join(shared, "config"), path.join(project, ".opencode")])
})
