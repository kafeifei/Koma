import path from "path"
import fs from "node:fs"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { containsPath } from "../project/instance-context"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  const requested = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  const unified = Boolean(process.env.OPENCODE_HOME?.trim())
  if (!unified && containsPath(requested, ins)) return false
  const physical = unified ? physicalPath(requested) : undefined
  const roots = [ins.directory, ...(ins.worktree === "/" ? [] : [ins.worktree])]
  // Directory aliases preserve task identity, but permission boundaries follow actual files.
  if (
    physical &&
    roots.some((root) => {
      const boundary = physicalPath(root)
      return boundary !== undefined && FSUtil.contains(boundary, physical)
    })
  )
    return false
  const full = physical ?? requested

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}

function physicalPath(input: string): string | undefined {
  const absolute = path.resolve(input)
  const entry = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (entry) {
    // A dangling or cyclic link cannot prove that a future write stays inside the project.
    if (entry.isSymbolicLink() && !fs.existsSync(absolute)) return
    return fs.realpathSync(absolute)
  }
  const parent = path.dirname(absolute)
  if (parent === absolute) return
  const canonical = physicalPath(parent)
  return canonical === undefined ? undefined : path.join(canonical, path.basename(absolute))
}
