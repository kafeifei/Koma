import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.instance("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
      }),
    ),
  )

  it.instance("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )
})

describe("Koma managed plugin loading", () => {
  it.instance("applies enabled plugins and keeps a loaded instance stable after disabling", () =>
    Effect.gen(function* () {
      const { readStore, updateStore } = yield* Effect.promise(() => import("../../src/koma/extensions/store"))
      const { installPlugin, changePlugin, listPlugins } = yield* Effect.promise(
        () => import("../../src/koma/extensions/plugins"),
      )
      const previous = yield* Effect.promise(() => readStore())
      yield* Effect.addFinalizer(() => Effect.promise(() => updateStore(() => previous)))
      const test = yield* TestInstance
      const file = path.join(test.directory, "managed.ts")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          `export default async (_input, options) => ({ "experimental.chat.system.transform": (_i, out) => out.system.push(options.marker) })`,
        ),
      )
      yield* Effect.promise(() => installPlugin({ spec: file, options: { marker: "managed-enabled" } }))
      expect(yield* triggerSystemTransform()).toEqual(["managed-enabled"])
      const id = pathToFileURL(file).href
      yield* Effect.promise(() => changePlugin(id, { enabled: false }))
      expect(yield* triggerSystemTransform()).toEqual(["managed-enabled"])
      expect((yield* Effect.promise(() => listPlugins())).find((p) => p.id === id)).toMatchObject({
        enabled: false,
        pending: true,
      })
    }),
  )

  it.instance("does not execute a managed plugin disabled before instance initialization", () =>
    Effect.gen(function* () {
      const { readStore, updateStore } = yield* Effect.promise(() => import("../../src/koma/extensions/store"))
      const { installPlugin, changePlugin } = yield* Effect.promise(() => import("../../src/koma/extensions/plugins"))
      const previous = yield* Effect.promise(() => readStore())
      yield* Effect.addFinalizer(() => Effect.promise(() => updateStore(() => previous)))
      const test = yield* TestInstance
      const file = path.join(test.directory, "disabled.ts")
      yield* Effect.promise(() =>
        Bun.write(file, `throw new Error("disabled plugin executed"); export default async () => ({})`),
      )
      yield* Effect.promise(() => installPlugin({ spec: file, options: {} }))
      yield* Effect.promise(() => changePlugin(pathToFileURL(file).href, { enabled: false }))
      expect(yield* triggerSystemTransform()).toEqual([])
    }),
  )
})
