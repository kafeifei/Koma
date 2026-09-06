import { createHash } from "node:crypto"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import path from "path"
import { Git } from "@/git"
import { WorktreeLifecycle } from "./lifecycle"

export const Resolution = Schema.Struct({ path: Schema.String, choice: Schema.Literals(["source", "target"]) })
export type Resolution = Schema.Schema.Type<typeof Resolution>
export const Input = Schema.Struct({ directory: Schema.String, resolutions: Schema.optional(Schema.Array(Resolution)) })
export type Input = Schema.Schema.Type<typeof Input>
export const Preview = Schema.Struct({
  directory: Schema.String,
  target: Schema.String,
  sourceHead: Schema.String,
  sourceTree: Schema.String,
  targetHead: Schema.String,
  mergedTree: Schema.String,
  conflicts: Schema.Array(Schema.String),
  resolutions: Schema.Array(Resolution),
  unresolved: Schema.Array(Schema.String),
  reviewID: Schema.String,
  files: Schema.Array(Schema.String),
  patch: Schema.String,
  truncated: Schema.Boolean,
})
export type Preview = Schema.Schema.Type<typeof Preview>
export const ApplyInput = Schema.Struct({
  directory: Schema.String,
  resolutions: Schema.optional(Schema.Array(Resolution)),
  reviewID: Schema.optional(Schema.String),
  sourceHead: Schema.String,
  sourceTree: Schema.String,
  targetHead: Schema.String,
  mergedTree: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>
export class MergeFailedError extends Schema.TaggedErrorClass<MergeFailedError>()("WorktreeMergeFailedError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly preview: (input: Input & { root: string }) => Effect.Effect<Preview, MergeFailedError>
  readonly apply: (input: ApplyInput & { root: string }) => Effect.Effect<boolean, MergeFailedError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeMerge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const fs = yield* FSUtil.Service
    const lifecycle = yield* WorktreeLifecycle.Service
    const fail = (message: string) => new MergeFailedError({ message })
    const run = Effect.fnUntraced(function* (cwd: string, args: string[], env?: Record<string, string>) {
      const result = yield* git.run(args, { cwd, env })
      if (result.exitCode !== 0 || result.truncated)
        return yield* fail(result.stderr.toString() || `git ${args[0]} failed`)
      return result.text().trim()
    })

    const locate = Effect.fnUntraced(function* (input: { root: string; directory: string }) {
      const requested = yield* fs.resolve(input.root)
      const directory = yield* fs.resolve(input.directory)
      const available = (yield* fs.exists(requested))
        ? requested
        : ((yield* lifecycle.getDirectory(requested))?.root ?? requested)
      const entries = (yield* run(available, ["worktree", "list", "--porcelain", "-z"]))
        .split("\0")
        .filter((item) => item.startsWith("worktree "))
        .map((item) => item.slice(9))
      const canonical = yield* Effect.forEach(entries, (entry) => fs.resolve(entry))
      const root = canonical[0]
      if (!root) return yield* fail("Git did not identify a primary worktree")
      if (directory === root || !canonical.includes(directory))
        return yield* fail("Source must be a linked worktree of this project")
      return { root, directory }
    })

    const requireClean = Effect.fnUntraced(function* (root: string) {
      if (yield* run(root, ["status", "--porcelain=v1", "--untracked-files=all"])) {
        return yield* fail("The target has uncommitted files; commit or move them before merging")
      }
      for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
        const file = yield* run(root, ["rev-parse", "--git-path", marker])
        if (yield* fs.exists(path.resolve(root, file))) return yield* fail("The target has an unfinished Git operation")
      }
    })

    const sourceTree = Effect.fnUntraced(function* (directory: string, head: string) {
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-worktree-merge-" })
      const env = { GIT_INDEX_FILE: path.join(temp, "index") }
      if (yield* run(directory, ["ls-files", "--unmerged"]))
        return yield* fail("Resolve source conflicts before merging")
      yield* run(directory, ["read-tree", head], env)
      yield* run(directory, ["add", "--all", "--", "."], env)
      // A gitlink cannot represent local files inside a submodule or a nested repository.
      if (
        (yield* run(directory, ["ls-files", "--stage"], env)).split("\n").some((line) => line.startsWith("160000 "))
      ) {
        return yield* fail("Submodules and nested repositories need to be merged separately")
      }
      return yield* run(directory, ["write-tree"], env)
    })

    const prepare = Effect.fnUntraced(function* (input: Input & { root: string }) {
      yield* requireClean(input.root)
      const sourceHead = yield* run(input.directory, ["rev-parse", "--verify", "HEAD"])
      const targetHead = yield* run(input.root, ["rev-parse", "--verify", "HEAD"])
      const tree = yield* sourceTree(input.directory, sourceHead)
      const commit = yield* run(
        input.directory,
        ["commit-tree", tree, "-p", sourceHead, "-m", "Worktree merge preview"],
        {
          GIT_AUTHOR_NAME: "OpenCode",
          GIT_AUTHOR_EMAIL: "worktree@localhost",
          GIT_COMMITTER_NAME: "OpenCode",
          GIT_COMMITTER_EMAIL: "worktree@localhost",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
      )
      const merged = yield* git.run(["merge-tree", "--write-tree", "--name-only", "-z", targetHead, commit], {
        cwd: input.root,
      })
      if (merged.exitCode > 1 || merged.truncated)
        return yield* fail(merged.stderr.toString() || "Cannot calculate merge")
      const parts = merged.text().split("\0")
      const automaticTree = parts[0]?.trim() ?? ""
      if (!/^[a-f0-9]{40,64}$/.test(automaticTree)) return yield* fail("Git did not produce a merge tree")
      const end = parts.indexOf("", 1)
      const conflicts = merged.exitCode === 1 ? parts.slice(1, end === -1 ? undefined : end) : []
      if (merged.exitCode === 1 && (end === -1 || !conflicts.length))
        return yield* fail("Git did not identify the conflicting files")
      const resolutions = [...(input.resolutions ?? [])].sort((a, b) => a.path.localeCompare(b.path))
      if (new Set(resolutions.map((item) => item.path)).size !== resolutions.length)
        return yield* fail("Choose each conflicting file only once")
      const extra = resolutions.find((item) => !conflicts.includes(item.path))
      if (extra) return yield* fail(`This file is not a current conflict; preview again: ${extra.path}`)
      const mergedTree = resolutions.length
        ? yield* resolveFiles({
            root: input.root,
            automaticTree,
            sourceTree: tree,
            targetHead,
            parts,
            end,
            resolutions,
          })
        : automaticTree
      const unresolved = conflicts.filter((file) => !resolutions.some((item) => item.path === file))
      const reviewID = createHash("sha256")
        .update(
          JSON.stringify({
            directory: input.directory,
            target: input.root,
            sourceHead,
            sourceTree: tree,
            targetHead,
            mergedTree,
            resolutions,
          }),
        )
        .digest("hex")
      const names = yield* git.run(["diff", "--name-only", "-z", targetHead, mergedTree], { cwd: input.root })
      if (names.exitCode !== 0 || names.truncated) return yield* fail("Cannot enumerate merged files")
      const files = names.text().split("\0").filter(Boolean)
      const patch = yield* git.run(["diff", "--no-ext-diff", "--no-textconv", targetHead, mergedTree, "--"], {
        cwd: input.root,
        maxOutputBytes: 256 * 1024,
      })
      if (patch.exitCode !== 0) return yield* fail(patch.stderr.toString())
      return {
        directory: input.directory,
        target: input.root,
        sourceHead,
        sourceTree: tree,
        targetHead,
        mergedTree,
        conflicts,
        resolutions,
        unresolved,
        reviewID,
        files,
        patch: patch.text(),
        truncated: patch.truncated,
      }
    })

    const resolveFiles = Effect.fnUntraced(function* (input: {
      root: string
      automaticTree: string
      sourceTree: string
      targetHead: string
      parts: string[]
      end: number
      resolutions: Resolution[]
    }) {
      // merge-tree -z emits count, paths, conflict kind, and message after its unmerged-path section.
      // Path-local replacement cannot safely resolve rename and directory/file relationships.
      for (let offset = input.end + 1; offset < input.parts.length - 1; ) {
        const count = Number(input.parts[offset])
        if (!Number.isSafeInteger(count) || count < 1 || offset + count + 2 >= input.parts.length)
          return yield* fail("Cannot interpret Git conflict details safely")
        const files = input.parts.slice(offset + 1, offset + count + 1)
        const kind = input.parts[offset + count + 1]!
        if (
          kind.startsWith("CONFLICT") &&
          (count !== 1 || !["CONFLICT (contents)", "CONFLICT (binary)", "CONFLICT (modify/delete)"].includes(kind))
        ) {
          return yield* fail(`Resolve this rename, directory, or unsupported conflict separately: ${files.join(", ")}`)
        }
        offset += count + 3
      }
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-worktree-resolution-" })
      const env = { GIT_INDEX_FILE: path.join(temp, "index") }
      yield* run(input.root, ["read-tree", input.automaticTree], env)
      for (const resolution of input.resolutions) {
        const entries = yield* Effect.forEach([input.sourceTree, input.targetHead], (tree) =>
          Effect.gen(function* () {
            const result = yield* git.run(
              ["ls-tree", "-z", "--full-tree", tree, "--", `:(literal)${resolution.path}`],
              { cwd: input.root },
            )
            if (result.exitCode !== 0 || result.truncated)
              return yield* fail(`Cannot inspect conflict safely: ${resolution.path}`)
            const records = result.text().split("\0").filter(Boolean)
            if (!records.length) return
            const match = /^(100644|100755|120000) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(records[0]!)
            if (records.length !== 1 || !match || match[3] !== resolution.path)
              return yield* fail(`Directory and special-file conflicts need separate resolution: ${resolution.path}`)
            return { mode: match[1]!, oid: match[2]! }
          }),
        )
        if (!entries.some(Boolean))
          return yield* fail(`Conflict has no source or target file; resolve it separately: ${resolution.path}`)
        const chosen = entries[resolution.choice === "source" ? 0 : 1]
        if (!chosen) {
          yield* run(input.root, ["update-index", "--force-remove", "--", resolution.path], env)
          continue
        }
        // A separate argv for the path preserves commas, whitespace and leading dashes.
        yield* run(input.root, ["update-index", "--add", "--cacheinfo", chosen.mode, chosen.oid, resolution.path], env)
      }
      return yield* run(input.root, ["write-tree"], env)
    })

    function locked<A, E, R>(input: { root: string; directory: string }, effect: Effect.Effect<A, E, R>) {
      const directories = [input.root, input.directory].sort()
      if (directories[1]!.startsWith(directories[0]! + path.sep))
        return lifecycle.withIdleDirectory(directories[0]!, effect)
      return lifecycle.withIdleDirectory(directories[0]!, lifecycle.withIdleDirectory(directories[1]!, effect))
    }

    const preview: Interface["preview"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const location = yield* locate(input)
          return yield* locked(location, prepare({ ...location, resolutions: input.resolutions }))
        }),
      ).pipe(Effect.mapError((error) => fail(error.message)))

    const apply: Interface["apply"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const location = yield* locate(input)
          return yield* locked(
            location,
            Effect.gen(function* () {
              const current = yield* prepare({ ...location, resolutions: input.resolutions })
              if (current.unresolved.length)
                return yield* fail("Choose a side for every conflict and preview the final patch before applying")
              if ((current.resolutions.length || input.reviewID) && input.reviewID !== current.reviewID)
                return yield* fail("Conflict choices changed after preview; preview the final patch again")
              if (
                ["sourceHead", "sourceTree", "targetHead", "mergedTree"].some(
                  (key) => current[key as keyof ApplyInput] !== input[key as keyof ApplyInput],
                )
              ) {
                return yield* fail("The source or target changed after preview; preview again")
              }
              if (!current.files.length) return true
              const patch = yield* git.run(
                ["diff", "--binary", "--no-ext-diff", "--no-textconv", current.targetHead, current.mergedTree, "--"],
                {
                  cwd: location.root,
                  maxOutputBytes: 32 * 1024 * 1024,
                },
              )
              if (patch.exitCode !== 0 || patch.truncated)
                return yield* fail("The merge patch is too large or cannot be read")
              // --index checks the old contents and refuses collisions, including ignored local files.
              // Git applies the whole patch only after checking every affected path.
              yield* requireClean(location.root)
              if ((yield* run(location.root, ["rev-parse", "HEAD"])) !== current.targetHead)
                return yield* fail("Target HEAD changed; preview again")
              const applied = yield* git.run(["apply", "--index", "--binary", "--whitespace=nowarn", "-"], {
                cwd: location.root,
                stdin: Stream.make(patch.stdout),
              })
              if (applied.exitCode !== 0) return yield* fail(applied.stderr.toString() || "Could not apply merge")
              return true
            }),
          )
        }),
      ).pipe(Effect.mapError((error) => fail(error.message)))

    return Service.of({ preview, apply })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Git.node, FSUtil.node, WorktreeLifecycle.node] })
export * as WorktreeMerge from "./merge"
