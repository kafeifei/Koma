import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { KomaInstructions } from "@opencode-ai/core/koma-instructions"
import { SystemContext } from "@opencode-ai/core/system-context"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const previousHome = process.env.CODEX_HOME
beforeAll(() => delete process.env.CODEX_HOME)
afterAll(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousHome
})

const withFiles = <A, E>(
  files: Record<string, string>,
  fn: (service: KomaInstructions.Interface, home: string) => Effect.Effect<A, E>,
  lab = true,
) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all(
            Object.entries(files).map(async ([file, content]) => {
              const target = path.join(tmp.path, file)
              await fs.mkdir(path.dirname(target), { recursive: true })
              await fs.writeFile(target, content)
            }),
          ),
        )
        const service = yield* KomaInstructions.Service
        return yield* fn(service, tmp.path)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(KomaInstructions.node, [
            [
              Global.node,
              Global.layerWith({
                home: tmp.path,
                root: lab ? path.join(tmp.path, "lab") : undefined,
                config: path.join(tmp.path, "lab", "config"),
              }),
            ],
          ]),
        ),
      ),
    ),
  )

const files = {
  ".agents/AGENTS.md": "common rules",
  "lab/config/AGENTS.md": "opencode rules",
  ".codex/AGENTS.md": "codex rules",
  ".codex/AGENTS.override.md": "codex override",
  ".claude/CLAUDE.md": "claude rules",
}

describe("KomaInstructions", () => {
  test.each([
    ["gpt-6-astra", "openai"],
    ["openai/gpt-5.6-sol", "openai"],
    ["xd/codex/gpt-5.5:auto", "openai"],
    ["o3-mini", "openai"],
    ["o1", "openai"],
    ["codex-mini-latest", "openai"],
    ["claude-opus-4-8", "anthropic"],
    ["us.anthropic.claude-sonnet-4-6-v1:0", "anthropic"],
    ["openai/gemini-3.1-pro", undefined],
    ["anthropic/deepseek-v4", undefined],
    ["my-gpt-wrapper", undefined],
    ["anonymous-model", undefined],
  ] as const)("classifies the API model %s without using the gateway vendor", (model, manufacturer) => {
    expect(KomaInstructions.vendor(model)).toBe(manufacturer)
  })

  it.live("always combines common rules with nonempty OpenCode rules", () =>
    withFiles(files, (service) =>
      Effect.gen(function* () {
        for (const model of ["gpt-6-astra", "claude-opus-4-8", "deepseek-v4"]) {
          const result = yield* service.load({ engine: "opencode", model })
          expect(result.map((file) => file.content)).toEqual(["common rules", "opencode rules"])
        }
      }),
    ),
  )

  it.live("falls back by the current model and replaces earlier vendor rules on a switch", () =>
    withFiles({ ...files, "lab/config/AGENTS.md": " \n" }, (service) =>
      Effect.gen(function* () {
        const initial = yield* SystemContext.initialize(yield* service.context("gpt-6-astra"))
        expect(initial.baseline).toContain("common rules")
        expect(initial.baseline).toContain("codex override")
        expect(initial.baseline).not.toContain("claude rules")

        const switched = yield* SystemContext.reconcile(yield* service.context("claude-opus-4-8"), initial.snapshot)
        expect(switched._tag).toBe("Updated")
        if (switched._tag !== "Updated") throw new Error("Expected updated instructions")
        expect(switched.text).toContain("replace all previously loaded global instructions")
        expect(switched.text).toContain("common rules")
        expect(switched.text).toContain("claude rules")
        expect(switched.text).not.toContain("codex override")

        const unknown = yield* service.load({ engine: "opencode", model: "deepseek-v4" })
        expect(unknown.map((file) => file.content)).toEqual(["common rules"])
      }),
    ),
  )

  it.live("skips empty overrides and honors an explicit CODEX_HOME", () =>
    withFiles(
      { ...files, "custom/AGENTS.override.md": "\n", "custom/AGENTS.md": "custom codex rules" },
      (service, home) =>
        Effect.gen(function* () {
          process.env.CODEX_HOME = path.join(home, "custom")
          const result = yield* service.load({ engine: "codex", model: "claude-opus-4-8" })
          expect(result.map((file) => file.content)).toEqual(["common rules", "custom codex rules"])
          expect(result[1].path).toBe(path.join(home, "custom", "AGENTS.md"))
        }).pipe(Effect.ensuring(Effect.sync(() => delete process.env.CODEX_HOME))),
    ),
  )

  it.live("Codex always combines common and Codex rules regardless of model or OpenCode rules", () =>
    withFiles(files, (service) =>
      Effect.gen(function* () {
        const result = yield* service.load({ engine: "codex", model: "claude-opus-4-8" })
        expect(result.map((file) => file.content)).toEqual(["common rules", "codex override"])
      }),
    ),
  )

  it.live("does not fall back to the other vendor when the selected vendor's files are missing", () =>
    withFiles({ ".agents/AGENTS.md": "common rules", ".claude/CLAUDE.md": "claude rules" }, (service) =>
      Effect.gen(function* () {
        const result = yield* service.load({ engine: "opencode", model: "gpt-6-astra" })
        expect(result.map((file) => file.content)).toEqual(["common rules"])
        const disabled = yield* service.load({
          engine: "opencode",
          model: "claude-opus-4-8",
          disableClaudeCodePrompt: true,
        })
        expect(disabled.map((file) => file.content)).toEqual(["common rules"])
      }),
    ),
  )

  it.live("preserves upstream context when no Lab profile is active", () =>
    withFiles(
      files,
      (service) =>
        Effect.gen(function* () {
          expect((yield* SystemContext.initialize(yield* service.context("gpt-6-astra"))).baseline).toBe("")
        }),
      false,
    ),
  )

  it.live("removes earlier global context when no rules apply to the newly selected model", () =>
    withFiles({ ".codex/AGENTS.md": "codex rules" }, (service) =>
      Effect.gen(function* () {
        const initial = yield* SystemContext.initialize(yield* service.context("gpt-6-astra"))
        expect(initial.baseline).toContain("codex rules")
        const empty = yield* service.context("deepseek-v4")
        expect((yield* SystemContext.initialize(empty)).baseline).toBe("")
        expect(yield* SystemContext.reconcile(empty, initial.snapshot)).toMatchObject({
          _tag: "Updated",
          text: "Previously loaded global instructions no longer apply.",
          snapshot: {},
        })
      }),
    ),
  )
})
