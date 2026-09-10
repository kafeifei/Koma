import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiConfig } from "../../../src/config/tui"

const { TuiPluginRuntime } = await import("../../../src/plugin/tui/runtime")

test("installs plugin without loading it", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "install-plugin.ts")
      const spec = pathToFileURL(file).href
      const marker = path.join(dir, "install.txt")

      await Bun.write(
        path.join(dir, "package.json"),
        JSON.stringify(
          {
            name: "demo-install-plugin",
            type: "module",
            exports: {
              "./tui": {
                import: "./install-plugin.ts",
                config: { marker },
              },
            },
          },
          null,
          2,
        ),
      )

      await Bun.write(
        file,
        `export default {
  id: "demo.install",
  tui: async (_api, options) => {
    if (!options?.marker) return
    await Bun.write(options.marker, "loaded")
  },
}
`,
      )

      return { spec, marker }
    },
  })

  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  const config = createTuiResolvedConfig({
    plugin: [],
  })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const api = createTuiPluginApi({
    state: {
      path: {
        state: path.join(tmp.path, "state.json"),
        config: path.join(tmp.path, "tui.json"),
        worktree: tmp.path,
        directory: tmp.path,
      },
    },
  })

  try {
    await TuiPluginRuntime.init({ api, config })
    const out = await TuiPluginRuntime.installPlugin(tmp.extra.spec)
    expect(out).toMatchObject({
      ok: true,
      tui: true,
    })

    await expect(fs.readFile(tmp.extra.marker, "utf8")).rejects.toThrow()
    await expect(TuiPluginRuntime.addPlugin(tmp.extra.spec)).resolves.toBe(true)
    await expect(fs.readFile(tmp.extra.marker, "utf8")).resolves.toBe("loaded")
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
})

test("a client-only host installs the TUI entry without changing server plugin configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "mixed-client-plugin",
          type: "module",
          exports: { "./server": "./server.ts", "./tui": "./tui.ts" },
        }),
      )
      await Bun.write(path.join(dir, "server.ts"), 'throw new Error("server entry must not load")')
      await Bun.write(path.join(dir, "tui.ts"), 'export default { id: "mixed.client", tui: async () => {} }')
      await Bun.write(path.join(dir, ".opencode", "opencode.json"), '{"model":"kept/model"}\n')
      return { spec: pathToFileURL(path.join(dir, "tui.ts")).href }
    },
  })
  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const api = createTuiPluginApi({
    state: {
      path: {
        state: path.join(tmp.path, "state.json"),
        config: path.join(tmp.path, "tui.json"),
        worktree: tmp.path,
        directory: tmp.path,
      },
    },
  })
  try {
    await TuiPluginRuntime.init({
      api,
      config: createTuiResolvedConfig({ plugin: [], plugin_origins: [] }),
      configOptions: { migrate: false },
      serverPlugins: false,
    })
    expect(await TuiPluginRuntime.installPlugin(tmp.extra.spec)).toMatchObject({ ok: true, tui: true })
    expect(await Bun.file(path.join(tmp.path, ".opencode", "opencode.json")).text()).toBe('{"model":"kept/model"}\n')
    expect(await Bun.file(path.join(tmp.path, ".opencode", "tui.json")).json()).toMatchObject({
      plugin: [tmp.extra.spec],
    })
    expect(await TuiPluginRuntime.addPlugin(tmp.extra.spec)).toBe(true)
    expect(TuiPluginRuntime.list().find((plugin) => plugin.id === "mixed.client")?.active).toBe(true)
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
})
