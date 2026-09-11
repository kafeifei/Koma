export * as LabInstructions from "./lab-instructions"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { truthy } from "./flag/flag"
import { SystemContext } from "./system-context/index"

const File = Schema.Struct({ path: Schema.String, content: Schema.String })
export type File = typeof File.Type

export type Selection = {
  engine: "opencode" | "codex"
  /** The actual API model ID, including any gateway namespace, not the provider's name. */
  model?: string
  disableClaudeCodePrompt?: boolean
}

export interface Interface {
  readonly load: (selection: Selection) => Effect.Effect<File[], FSUtil.Error>
  readonly context: (model: string) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LabInstructions") {}

export function vendor(model: string | undefined): "openai" | "anthropic" | undefined {
  if (!model) return undefined
  if (/(?:^|[/.:-])claude(?:[-_.:]|$)/i.test(model)) return "anthropic"
  if (/(?:^|[/.:-])(?:gpt-\d|chatgpt(?:[-_.:]|$)|codex(?:[-_.:]|$)|o\d+(?:[-_.:]|$))/i.test(model)) return "openai"
  return undefined
}

export const render = (files: ReadonlyArray<File>) =>
  files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const first = Effect.fn("LabInstructions.first")(function* (paths: string[]) {
      for (const file of paths) {
        const content = yield* fs.readFileStringSafe(file)
        if (content?.trim()) return { path: path.resolve(file), content }
      }
      return undefined
    })

    const load = Effect.fn("LabInstructions.load")(function* (selection: Selection) {
      const common = yield* first([path.join(global.home, ".agents", "AGENTS.md")])
      const opencode =
        selection.engine === "opencode" ? yield* first([path.join(global.config, "AGENTS.md")]) : undefined
      const manufacturer = selection.engine === "codex" ? "openai" : vendor(selection.model)
      const codexHome = process.env.CODEX_HOME || path.join(global.home, ".codex")
      const fallback = opencode
        ? undefined
        : yield* first(
            manufacturer === "openai"
              ? [path.join(codexHome, "AGENTS.override.md"), path.join(codexHome, "AGENTS.md")]
              : manufacturer === "anthropic" && !selection.disableClaudeCodePrompt
                ? [path.join(global.home, ".claude", "CLAUDE.md")]
                : [],
          )
      return Array.from(
        new Map(
          [common, opencode ?? fallback]
            .filter((file): file is File => file !== undefined)
            .map((file) => [file.path, file]),
        ).values(),
      )
    })

    return Service.of({
      load,
      context: Effect.fn("LabInstructions.context")(function* (model) {
        if (!global.root) return SystemContext.empty
        const files = yield* load({
          engine: "opencode",
          model,
          disableClaudeCodePrompt:
            truthy("OPENCODE_DISABLE_CLAUDE_CODE") || truthy("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"),
        }).pipe(Effect.catch(() => Effect.succeed(SystemContext.unavailable)))
        if (files !== SystemContext.unavailable && files.length === 0) return SystemContext.empty
        return SystemContext.make({
          key: SystemContext.Key.make("lab/global-instructions"),
          codec: Schema.toCodecJson(Schema.Array(File)),
          load: Effect.succeed(files),
          baseline: render,
          update: (_previous, current) =>
            `These global instructions replace all previously loaded global instructions.\n\n${render(current)}`,
          removed: () => "Previously loaded global instructions no longer apply.",
        })
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })
