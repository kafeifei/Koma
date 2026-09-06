import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Git } from "@/git"

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const MISSING_OID = "0000000000000000000000000000000000000000"
const REF_ROOT = "refs/opencode/worktree-archive"
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const Snapshot = Schema.Struct({
  baseCommit: Schema.String,
  baseTree: Schema.String,
  indexTree: Schema.String,
  workingTree: Schema.String,
  untrackedTree: Schema.optional(Schema.String),
})
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

export class ArchiveFailedError extends Schema.TaggedErrorClass<ArchiveFailedError>()("WorktreeArchiveFailedError", {
  operation: Schema.Literals(["capture", "restore", "clear"]),
  message: Schema.String,
}) {}

export type CaptureInput = {
  readonly directory: string
  readonly branch: string
  readonly sessionID: string
}

export type CaptureResult = {
  readonly ref: string
  readonly oid: string
  readonly snapshot: Snapshot
  readonly hasChanges: boolean
}

export type RestoreInput = CaptureInput & {
  readonly oid: string
}

export type RestoreResult = {
  readonly ref: string
  readonly oid: string
  readonly snapshot: Snapshot
  readonly alreadyApplied: boolean
}

export type ClearInput = {
  readonly directory: string
  readonly sessionID: string
  readonly oid: string
}

export interface Interface {
  readonly capture: (input: CaptureInput) => Effect.Effect<CaptureResult, ArchiveFailedError>
  readonly restore: (input: RestoreInput) => Effect.Effect<RestoreResult, ArchiveFailedError>
  readonly clear: (input: ClearInput) => Effect.Effect<void, ArchiveFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorktreeArchive") {}

const layer: Layer.Layer<Service, never, Git.Service | FSUtil.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const fs = yield* FSUtil.Service

    const failed = (operation: ArchiveFailedError["operation"], message: string) =>
      new ArchiveFailedError({ operation, message })

    const run = Effect.fnUntraced(function* (
      operation: ArchiveFailedError["operation"],
      directory: string,
      args: string[],
      options?: { readonly env?: Record<string, string>; readonly stdin?: string },
    ) {
      const result = yield* git.run(args, {
        cwd: directory,
        env: options?.env,
        stdin: options?.stdin ? Stream.make(new TextEncoder().encode(options.stdin)) : undefined,
      })
      if (result.exitCode === 0) return args.includes("-z") ? result.text() : result.text().trim()
      const detail = result.stderr.toString("utf8").trim() || result.text().trim() || `exit ${result.exitCode}`
      return yield* failed(operation, `git ${args[0]} failed: ${detail}`)
    })

    const optional = Effect.fnUntraced(function* (directory: string, args: string[]) {
      const result = yield* git.run(args, { cwd: directory })
      if (result.exitCode !== 0) return
      return result.text().trim() || undefined
    })

    const archiveRef = (operation: ArchiveFailedError["operation"], sessionID: string) => {
      if (!ID_PATTERN.test(sessionID) || sessionID.includes("..") || sessionID.endsWith(".")) {
        return Effect.fail(failed(operation, "session ID cannot be represented by a private Git ref"))
      }
      return Effect.succeed(`${REF_ROOT}/${sessionID}`)
    }

    const assertBranch = Effect.fnUntraced(function* (operation: ArchiveFailedError["operation"], input: CaptureInput) {
      const branch = yield* optional(input.directory, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      if (branch === input.branch) return
      return yield* failed(
        operation,
        branch
          ? `worktree branch changed from ${input.branch} to ${branch}`
          : `worktree is no longer on branch ${input.branch}`,
      )
    })

    const stage = Effect.fnUntraced(function* (
      operation: ArchiveFailedError["operation"],
      directory: string,
      temp: string,
      name: string,
      seed: string,
      files: string[],
    ) {
      const index = path.join(temp, `${name}.index`)
      const env = {
        GIT_INDEX_FILE: index,
        GIT_LITERAL_PATHSPECS: "1",
        COMMAND_HOOK_LOCK: "1",
      }
      yield* run(operation, directory, ["read-tree", seed], { env })
      if (files.length > 0) {
        const pathspec = path.join(temp, `${name}.pathspec`)
        yield* fs
          .writeFile(pathspec, Buffer.from(`${files.join("\0")}\0`))
          .pipe(
            Effect.mapError((error) => failed(operation, `failed to write temporary Git pathspec: ${error.message}`)),
          )
        yield* run(
          operation,
          directory,
          ["add", "-f", "-A", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"],
          { env },
        )
      }
      return yield* run(operation, directory, ["write-tree"], { env })
    })

    const captureSnapshot = (operation: ArchiveFailedError["operation"], input: CaptureInput) =>
      Effect.gen(function* () {
        yield* assertBranch(operation, input)
        const baseCommit = yield* run(operation, input.directory, ["rev-parse", "--verify", "HEAD"])
        const status = yield* run(operation, input.directory, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ])
        const baseTree = yield* run(operation, input.directory, ["rev-parse", "--verify", `${baseCommit}^{tree}`])
        const indexTree = yield* run(operation, input.directory, ["write-tree"])
        const tracked = (yield* run(operation, input.directory, ["diff-files", "--name-only", "-z", "--"]))
          .split("\0")
          .filter(Boolean)
        const untracked = (yield* run(operation, input.directory, ["ls-files", "--others", "--exclude-standard", "-z"]))
          .split("\0")
          .filter(Boolean)
        const temp = yield* fs
          .makeTempDirectoryScoped({ prefix: "opencode-worktree-archive-" })
          .pipe(Effect.mapError((error) => failed(operation, `failed to create temporary Git index: ${error.message}`)))
        const workingTree = yield* stage(operation, input.directory, temp, "working", indexTree, tracked)
        const untrackedTree =
          untracked.length > 0
            ? yield* stage(operation, input.directory, temp, "untracked", EMPTY_TREE, untracked)
            : undefined

        const raw = yield* Effect.all([
          run(operation, input.directory, ["diff", "--raw", "--no-renames", baseTree, indexTree, "--"]),
          run(operation, input.directory, ["diff", "--raw", "--no-renames", indexTree, workingTree, "--"]),
          untrackedTree
            ? run(operation, input.directory, ["diff", "--raw", "--no-renames", EMPTY_TREE, untrackedTree, "--"])
            : Effect.succeed(""),
        ])
        if (raw.some((output) => output.split(/\r?\n/).some((line) => /^:(?:160000 \d{6}|\d{6} 160000) /.test(line)))) {
          return yield* failed(operation, "dirty nested repositories cannot be represented by an archive snapshot")
        }

        const endCommit = yield* run(operation, input.directory, ["rev-parse", "--verify", "HEAD"])
        const endIndex = yield* run(operation, input.directory, ["write-tree"])
        if (endCommit !== baseCommit || endIndex !== indexTree) {
          return yield* failed(operation, "worktree HEAD or index changed while the archive snapshot was captured")
        }
        if (status && indexTree === baseTree && workingTree === baseTree && !untrackedTree) {
          return yield* failed(operation, "dirty worktree state cannot be represented by an archive snapshot")
        }
        return {
          baseCommit,
          baseTree,
          indexTree,
          workingTree,
          ...(untrackedTree ? { untrackedTree } : {}),
        } satisfies Snapshot
      }).pipe(Effect.scoped)

    const same = (left: Snapshot, right: Snapshot) =>
      left.baseCommit === right.baseCommit &&
      left.baseTree === right.baseTree &&
      left.indexTree === right.indexTree &&
      left.workingTree === right.workingTree &&
      left.untrackedTree === right.untrackedTree

    const changed = (snapshot: Snapshot) =>
      snapshot.indexTree !== snapshot.baseTree ||
      snapshot.workingTree !== snapshot.baseTree ||
      snapshot.untrackedTree !== undefined

    const commit = Effect.fnUntraced(function* (
      operation: ArchiveFailedError["operation"],
      input: CaptureInput,
      tree: string,
      parents: string[],
      message: string,
    ) {
      return yield* run(
        operation,
        input.directory,
        ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message],
        {
          env: {
            GIT_AUTHOR_NAME: "OpenCode",
            GIT_AUTHOR_EMAIL: "opencode@localhost",
            GIT_COMMITTER_NAME: "OpenCode",
            GIT_COMMITTER_EMAIL: "opencode@localhost",
          },
        },
      )
    })

    const readSnapshotAt = Effect.fnUntraced(function* (input: CaptureInput, oid: string) {
      const values = yield* Effect.all([
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^1`]),
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^1^{tree}`]),
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^2^{tree}`]),
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^{tree}`]),
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^3^{tree}`]),
      ])
      if (!values[0] || !values[1] || !values[2] || !values[3]) {
        return yield* failed("restore", `archive object ${oid} does not contain a valid worktree snapshot`)
      }
      return {
        oid,
        snapshot: {
          baseCommit: values[0],
          baseTree: values[1],
          indexTree: values[2],
          workingTree: values[3],
          ...(values[4] ? { untrackedTree: values[4] } : {}),
        } satisfies Snapshot,
      }
    })

    const readSnapshot = Effect.fnUntraced(function* (input: CaptureInput, ref: string) {
      const oid = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (!oid) return yield* failed("restore", `archive ref ${ref} is missing`)
      return yield* readSnapshotAt(input, oid)
    })

    const capture = Effect.fn("WorktreeArchive.capture")(function* (input: CaptureInput) {
      const ref = yield* archiveRef("capture", input.sessionID)
      const snapshot = yield* captureSnapshot("capture", input)
      const hasChanges = changed(snapshot)
      const existing = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (existing) {
        const archived = yield* readSnapshot(input, ref).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (archived && same(snapshot, archived.snapshot)) {
          const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
          if (current !== archived.oid)
            return yield* failed("capture", `archive ref ${ref} changed during capture retry`)
          return { ref, oid: archived.oid, snapshot, hasChanges } satisfies CaptureResult
        }
      }

      const index = yield* commit(
        "capture",
        input,
        snapshot.indexTree,
        [snapshot.baseCommit],
        `${input.sessionID} archived index`,
      )
      const untracked = snapshot.untrackedTree
        ? yield* commit("capture", input, snapshot.untrackedTree, [], `${input.sessionID} archived untracked files`)
        : undefined
      const oid = yield* commit(
        "capture",
        input,
        snapshot.workingTree,
        [snapshot.baseCommit, index, ...(untracked ? [untracked] : [])],
        `${input.sessionID} archived worktree`,
      )
      yield* run("capture", input.directory, ["update-ref", ref, oid, existing ?? MISSING_OID])

      const final = yield* captureSnapshot("capture", input)
      if (!same(snapshot, final)) {
        return yield* failed("capture", "worktree changed while the archive ref was finalized")
      }
      const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (current !== oid) return yield* failed("capture", `archive ref ${ref} changed while capture was finalized`)
      return { ref, oid, snapshot, hasChanges } satisfies CaptureResult
    })

    const restore = Effect.fn("WorktreeArchive.restore")(function* (input: RestoreInput) {
      const ref = yield* archiveRef("restore", input.sessionID)
      const currentRef = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (!currentRef) {
        const expected = yield* readSnapshotAt(input, input.oid)
        const live = yield* captureSnapshot("restore", input)
        if (!same(live, expected.snapshot)) {
          return yield* failed("restore", `archive ref ${ref} is missing and the restored worktree changed`)
        }
        return {
          ref,
          oid: input.oid,
          snapshot: expected.snapshot,
          alreadyApplied: true,
        } satisfies RestoreResult
      }
      const expected = yield* readSnapshot(input, ref)
      if (expected.oid !== input.oid) {
        return yield* failed("restore", `archive ref ${ref} changed after lifecycle persistence`)
      }
      const live = yield* captureSnapshot("restore", input)
      if (live.baseCommit !== expected.snapshot.baseCommit) {
        return yield* failed("restore", "preserved branch no longer matches the archived base commit")
      }
      if (same(live, expected.snapshot)) {
        const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
        if (current !== input.oid) return yield* failed("restore", `archive ref ${ref} changed during restoration`)
        return {
          ref,
          oid: expected.oid,
          snapshot: expected.snapshot,
          alreadyApplied: true,
        } satisfies RestoreResult
      }
      if (changed(live)) {
        return yield* failed("restore", "worktree differs from both the archived snapshot and its clean base")
      }

      yield* run("restore", input.directory, ["stash", "apply", "--index", input.oid])
      const restored = yield* captureSnapshot("restore", input)
      if (!same(restored, expected.snapshot)) {
        return yield* failed("restore", "restored worktree did not match the archived snapshot")
      }
      const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (current !== input.oid) return yield* failed("restore", `archive ref ${ref} changed during restoration`)
      return {
        ref,
        oid: expected.oid,
        snapshot: expected.snapshot,
        alreadyApplied: false,
      } satisfies RestoreResult
    })

    const clear = Effect.fn("WorktreeArchive.clear")(function* (input: ClearInput) {
      const ref = yield* archiveRef("clear", input.sessionID)
      const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (!current) return
      if (current !== input.oid) return yield* failed("clear", `archive ref ${ref} changed before deletion`)
      const result = yield* git.run(["update-ref", "-d", ref, input.oid], { cwd: input.directory })
      if (result.exitCode === 0) return
      const after = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (!after) return
      if (after !== input.oid) return yield* failed("clear", `archive ref ${ref} changed during deletion`)
      const detail = result.stderr.toString("utf8").trim() || result.text().trim() || `exit ${result.exitCode}`
      return yield* failed("clear", `git update-ref failed: ${detail}`)
    })

    return Service.of({ capture, restore, clear })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Git.node, FSUtil.node] })

export * as WorktreeArchive from "./archive"
