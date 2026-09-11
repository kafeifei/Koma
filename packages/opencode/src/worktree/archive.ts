import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { lstat } from "node:fs/promises"
import path from "path"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { Git } from "@/git"
import { WorktreeIgnoredPolicy } from "./ignored-policy"

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const MISSING_OID = "0000000000000000000000000000000000000000"
const REF_ROOT = "refs/opencode/worktree-archive"
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DEFAULT_IGNORED_MODE = "local" satisfies WorktreeIgnoredPolicy.Mode

const IgnoredMode = Schema.Literals(["local", "all"])
const IgnoredMetadata = Schema.Struct({
  version: Schema.Literal(1),
  mode: IgnoredMode,
  directories: Schema.Array(Schema.String),
})
const decodeIgnoredMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(IgnoredMetadata))

export const Snapshot = Schema.Struct({
  baseCommit: Schema.String,
  baseTree: Schema.String,
  indexTree: Schema.String,
  workingTree: Schema.String,
  untrackedTree: Schema.optional(Schema.String),
  ignoredTree: Schema.optional(Schema.String),
  ignoredMode: Schema.optional(IgnoredMode),
  ignoredDirectories: Schema.optional(Schema.Array(Schema.String)),
})
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

export class ArchiveFailedError extends Schema.TaggedErrorClass<ArchiveFailedError>()("WorktreeArchiveFailedError", {
  operation: Schema.Literals(["preview", "capture", "verify", "restore", "clear"]),
  message: Schema.String,
}) {}

export type CaptureInput = {
  readonly directory: string
  readonly branch: string
  readonly sessionID: string
  readonly ignored?: WorktreeIgnoredPolicy.Mode
}

export type IgnoredEntry = {
  readonly path: string
  readonly type: "file" | "directory" | "symlink" | "other"
  readonly reason: string
  readonly bytes?: number
}

export type IgnoredPreview = {
  readonly mode: WorktreeIgnoredPolicy.Mode
  readonly preserved: readonly IgnoredEntry[]
  readonly skipped: readonly IgnoredEntry[]
  readonly unsupported: readonly IgnoredEntry[]
}

export type CaptureResult = {
  readonly ref: string
  readonly oid: string
  readonly snapshot: Snapshot
  readonly hasChanges: boolean
  readonly ignored: IgnoredPreview
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

export type VerifyResult = {
  readonly ref: string
  readonly oid: string
  readonly snapshot: Snapshot
}

export type ClearInput = {
  readonly directory: string
  readonly sessionID: string
  readonly oid: string
}

export interface Interface {
  readonly preview: (input: CaptureInput) => Effect.Effect<IgnoredPreview, ArchiveFailedError>
  readonly capture: (input: CaptureInput) => Effect.Effect<CaptureResult, ArchiveFailedError>
  readonly baseCommit: (input: ClearInput) => Effect.Effect<string, ArchiveFailedError>
  readonly verify: (input: RestoreInput) => Effect.Effect<VerifyResult, ArchiveFailedError>
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

    const target = (directory: string, filepath: string) => {
      const segments = filepath.replace(/\/$/, "").split("/")
      if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) return
      const result = path.resolve(directory, ...segments)
      if (!FSUtil.contains(directory, result)) return
      return result
    }

    const inspectIgnored = Effect.fnUntraced(function* (
      operation: ArchiveFailedError["operation"],
      input: CaptureInput,
      mode: WorktreeIgnoredPolicy.Mode,
    ) {
      const listed = (yield* run(operation, input.directory, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
        "--",
      ]))
        .split("\0")
        .filter(Boolean)
      const preserved: IgnoredEntry[] = []
      const skipped: IgnoredEntry[] = []
      const unsupported: IgnoredEntry[] = []

      const inspect = (
        filepath: string,
        inherited?: { readonly path: string; readonly reason: string; bytes: number },
      ): Effect.Effect<void, ArchiveFailedError> =>
        Effect.gen(function* () {
          const absolute = target(input.directory, filepath)
          if (!absolute) {
            unsupported.push({ path: filepath, type: "other", reason: "path escapes the managed worktree" })
            return
          }
          const info = yield* Effect.tryPromise({
            try: () => lstat(absolute),
            catch: (error) =>
              failed(operation, `cannot inspect ignored path ${JSON.stringify(filepath)}: ${String(error)}`),
          }).pipe(Effect.option)
          if (Option.isNone(info)) {
            unsupported.push({ path: filepath, type: "other", reason: "path disappeared or cannot be inspected" })
            return
          }
          const type = info.value.isDirectory()
            ? "directory"
            : info.value.isSymbolicLink()
              ? "symlink"
              : info.value.isFile()
                ? "file"
                : "other"
          const bytes = type === "file" ? Number(info.value.size) : undefined
          const decision = inherited
            ? { action: "skip" as const, reason: inherited.reason }
            : WorktreeIgnoredPolicy.decide(filepath, mode)
          const skippedRoot =
            inherited ??
            (decision.action === "skip"
              ? { path: filepath.replace(/\/$/, ""), reason: decision.reason, bytes: 0 }
              : undefined)
          if (skippedRoot && bytes !== undefined) skippedRoot.bytes += bytes

          if (type === "other") {
            unsupported.push({ path: filepath, type, reason: "special filesystem entries cannot be stored in Git" })
            return
          }
          if (type === "symlink") {
            const link = yield* fs.readLink(absolute).pipe(Effect.option)
            if (Option.isNone(link)) {
              unsupported.push({ path: filepath, type, reason: "symbolic link changed or cannot be read" })
              return
            }
            const entry = {
              path: filepath,
              type,
              reason: decision.reason,
              bytes: Buffer.byteLength(link.value),
            } as const
            if (!skippedRoot) preserved.push(entry)
            if (skippedRoot) skippedRoot.bytes += entry.bytes
            if (!inherited && skippedRoot) skipped.push({ ...entry, path: skippedRoot.path, bytes: skippedRoot.bytes })
            return
          }
          if (type === "file") {
            const entry = {
              path: filepath,
              type,
              reason: decision.reason,
              ...(bytes === undefined ? {} : { bytes }),
            } as const
            if (!skippedRoot) preserved.push(entry)
            if (!inherited && skippedRoot) skipped.push({ ...entry, path: skippedRoot.path, bytes: skippedRoot.bytes })
            return
          }

          const entries = yield* fs.readDirectoryEntries(absolute).pipe(
            Effect.catch(() => {
              unsupported.push({ path: filepath, type, reason: "directory cannot be read" })
              return Effect.succeed([])
            }),
          )
          if (entries.some((entry) => entry.name === ".git")) {
            unsupported.push({ path: filepath, type, reason: "nested Git repositories cannot be stored safely" })
            return
          }
          if (!skippedRoot) preserved.push({ path: filepath.replace(/\/$/, ""), type, reason: decision.reason })
          yield* Effect.forEach(
            entries,
            (entry) => inspect(`${filepath.replace(/\/$/, "")}/${entry.name}`, skippedRoot),
            { concurrency: 1, discard: true },
          )
          if (!inherited && skippedRoot) {
            skipped.push({
              path: skippedRoot.path,
              type: "directory",
              reason: skippedRoot.reason,
              bytes: skippedRoot.bytes,
            })
          }
        })

      yield* Effect.forEach(listed, (filepath) => inspect(filepath), { concurrency: 1, discard: true })
      const order = (left: IgnoredEntry, right: IgnoredEntry) => left.path.localeCompare(right.path)
      return {
        mode,
        preserved: preserved.sort(order),
        skipped: skipped.sort(order),
        unsupported: unsupported.sort(order),
      } satisfies IgnoredPreview
    })

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

    const captureSnapshot = (
      operation: ArchiveFailedError["operation"],
      input: CaptureInput,
      ignoredMode: WorktreeIgnoredPolicy.Mode | "legacy" = input.ignored ?? DEFAULT_IGNORED_MODE,
    ) =>
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
        const ignored =
          ignoredMode === "legacy"
            ? ({ mode: DEFAULT_IGNORED_MODE, preserved: [], skipped: [], unsupported: [] } satisfies IgnoredPreview)
            : yield* inspectIgnored(operation, input, ignoredMode)
        if (ignored.unsupported.length > 0) {
          return yield* failed(
            operation,
            `ignored worktree state cannot be represented safely: ${ignored.unsupported
              .slice(0, 5)
              .map((entry) => `${JSON.stringify(entry.path)} (${entry.reason})`)
              .join(", ")}`,
          )
        }
        const temp = yield* fs
          .makeTempDirectoryScoped({ prefix: "opencode-worktree-archive-" })
          .pipe(Effect.mapError((error) => failed(operation, `failed to create temporary Git index: ${error.message}`)))
        const workingTree = yield* stage(operation, input.directory, temp, "working", indexTree, tracked)
        const untrackedTree =
          untracked.length > 0
            ? yield* stage(operation, input.directory, temp, "untracked", EMPTY_TREE, untracked)
            : undefined
        const ignoredFiles = ignored.preserved
          .filter((entry) => entry.type === "file" || entry.type === "symlink")
          .map((entry) => entry.path)
        const ignoredDirectories = ignored.preserved
          .filter((entry) => entry.type === "directory")
          .map((entry) => entry.path)
        const ignoredTree =
          ignoredMode !== "legacy"
            ? yield* stage(operation, input.directory, temp, "ignored", EMPTY_TREE, ignoredFiles)
            : undefined
        const capturedIgnoredMode = ignoredMode === "legacy" ? undefined : ignoredMode

        const raw = yield* Effect.all([
          run(operation, input.directory, ["diff", "--raw", "--no-renames", baseTree, indexTree, "--"]),
          run(operation, input.directory, ["diff", "--raw", "--no-renames", indexTree, workingTree, "--"]),
          untrackedTree
            ? run(operation, input.directory, ["diff", "--raw", "--no-renames", EMPTY_TREE, untrackedTree, "--"])
            : Effect.succeed(""),
          ignoredTree
            ? run(operation, input.directory, ["diff", "--raw", "--no-renames", EMPTY_TREE, ignoredTree, "--"])
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
          snapshot: {
            baseCommit,
            baseTree,
            indexTree,
            workingTree,
            ...(untrackedTree ? { untrackedTree } : {}),
            ...(ignoredTree
              ? {
                  ignoredTree,
                  ignoredMode: capturedIgnoredMode!,
                  ignoredDirectories,
                }
              : {}),
          } satisfies Snapshot,
          ignored,
        }
      }).pipe(Effect.scoped)

    const same = (left: Snapshot, right: Snapshot) =>
      left.baseCommit === right.baseCommit &&
      left.baseTree === right.baseTree &&
      left.indexTree === right.indexTree &&
      left.workingTree === right.workingTree &&
      left.untrackedTree === right.untrackedTree &&
      left.ignoredTree === right.ignoredTree &&
      left.ignoredMode === right.ignoredMode &&
      (left.ignoredDirectories ?? []).join("\0") === (right.ignoredDirectories ?? []).join("\0")

    const sameCore = (left: Snapshot, right: Snapshot) =>
      left.baseCommit === right.baseCommit &&
      left.baseTree === right.baseTree &&
      left.indexTree === right.indexTree &&
      left.workingTree === right.workingTree &&
      left.untrackedTree === right.untrackedTree

    const changedCore = (snapshot: Snapshot) =>
      snapshot.indexTree !== snapshot.baseTree ||
      snapshot.workingTree !== snapshot.baseTree ||
      snapshot.untrackedTree !== undefined

    const changed = (snapshot: Snapshot) =>
      snapshot.indexTree !== snapshot.baseTree ||
      snapshot.workingTree !== snapshot.baseTree ||
      snapshot.untrackedTree !== undefined ||
      (snapshot.ignoredTree !== undefined &&
        (snapshot.ignoredTree !== EMPTY_TREE || (snapshot.ignoredDirectories?.length ?? 0) > 0))

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

    const readSnapshotAt = Effect.fnUntraced(function* (
      operation: ArchiveFailedError["operation"],
      input: Pick<CaptureInput, "directory">,
      oid: string,
    ) {
      const values = yield* Effect.all([
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^1`]),
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^1^{tree}`]),
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^2^{tree}`]),
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^{tree}`]),
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^3^{tree}`]),
        optional(input.directory, ["rev-parse", "--verify", "--quiet", `${oid}^4^{tree}`]),
        optional(input.directory, ["show", "-s", "--format=%B", `${oid}^4`]),
      ])
      if (!values[0] || !values[1] || !values[2] || !values[3]) {
        return yield* failed(operation, `archive object ${oid} does not contain a valid worktree snapshot`)
      }
      const metadata = values[5] && values[6] ? decodeIgnoredMetadata(values[6]) : Option.none()
      if (values[5] && Option.isNone(metadata)) {
        return yield* failed(operation, `archive object ${oid} contains invalid ignored-file metadata`)
      }
      return {
        oid,
        snapshot: {
          baseCommit: values[0],
          baseTree: values[1],
          indexTree: values[2],
          workingTree: values[3],
          ...(values[4] && values[4] !== EMPTY_TREE ? { untrackedTree: values[4] } : {}),
          ...(values[5] && Option.isSome(metadata)
            ? {
                ignoredTree: values[5],
                ignoredMode: metadata.value.mode,
                ignoredDirectories: [...metadata.value.directories],
              }
            : {}),
        } satisfies Snapshot,
      }
    })

    const readSnapshot = Effect.fnUntraced(function* (
      operation: ArchiveFailedError["operation"],
      input: Pick<CaptureInput, "directory">,
      ref: string,
    ) {
      const oid = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (!oid) return yield* failed(operation, `archive ref ${ref} is missing`)
      return yield* readSnapshotAt(operation, input, oid)
    })

    const treeEntries = Effect.fnUntraced(function* (
      operation: ArchiveFailedError["operation"],
      input: CaptureInput,
      tree: string | undefined,
    ) {
      if (!tree) return new Map<string, string>()
      const output = yield* run(operation, input.directory, ["ls-tree", "-r", "-z", "--full-tree", tree])
      return new Map(
        output
          .split("\0")
          .filter(Boolean)
          .map((record) => {
            const split = record.indexOf("\t")
            if (split < 0) return [record, ""] as const
            return [record.slice(split + 1), record.slice(0, split)] as const
          }),
      )
    })

    const missingIgnored = Effect.fnUntraced(function* (
      operation: ArchiveFailedError["operation"],
      input: CaptureInput,
      live: Snapshot,
      expected: Snapshot,
    ) {
      const current = yield* treeEntries(operation, input, live.ignoredTree)
      const archived = yield* treeEntries(operation, input, expected.ignoredTree)
      const collision = [...current].find(([filepath, entry]) => archived.get(filepath) !== entry)
      if (collision) {
        return yield* failed(
          operation,
          `ignored path ${JSON.stringify(collision[0])} differs from the archived snapshot`,
        )
      }
      const directories = new Set(expected.ignoredDirectories ?? [])
      const unexpected = (live.ignoredDirectories ?? []).find((directory) => !directories.has(directory))
      if (unexpected) {
        return yield* failed(
          operation,
          `ignored directory ${JSON.stringify(unexpected)} differs from the archived snapshot`,
        )
      }
      return {
        files: [...archived.keys()].filter((filepath) => !current.has(filepath)),
        directories: [...directories].filter((directory) => !(live.ignoredDirectories ?? []).includes(directory)),
      }
    })

    const restoreIgnored = Effect.fnUntraced(function* (
      input: RestoreInput,
      snapshot: Snapshot,
      missing: { readonly files: string[]; readonly directories: string[] },
    ) {
      if (!snapshot.ignoredTree) return
      yield* Effect.forEach(
        missing.directories.sort((left, right) => left.split("/").length - right.split("/").length),
        (directory) => {
          const absolute = target(input.directory, directory)
          if (!absolute)
            return Effect.fail(failed("restore", `ignored directory ${JSON.stringify(directory)} is unsafe`))
          return fs
            .makeDirectory(absolute, { recursive: true })
            .pipe(Effect.mapError((error) => failed("restore", `cannot restore ignored directory: ${error.message}`)))
        },
        { concurrency: 1, discard: true },
      )
      if (missing.files.length === 0) return
      const temp = yield* fs
        .makeTempDirectoryScoped({ prefix: "opencode-worktree-restore-" })
        .pipe(Effect.mapError((error) => failed("restore", `failed to create temporary Git index: ${error.message}`)))
      const env = { GIT_INDEX_FILE: path.join(temp, "ignored.index"), COMMAND_HOOK_LOCK: "1" }
      yield* run("restore", input.directory, ["read-tree", snapshot.ignoredTree], { env })
      yield* run("restore", input.directory, ["checkout-index", "-z", "--stdin"], {
        env,
        stdin: `${missing.files.join("\0")}\0`,
      })
    })

    const preview = Effect.fn("WorktreeArchive.preview")(function* (input: CaptureInput) {
      yield* assertBranch("preview", input)
      return yield* inspectIgnored("preview", input, input.ignored ?? DEFAULT_IGNORED_MODE)
    })

    const capture = Effect.fn("WorktreeArchive.capture")(function* (input: CaptureInput) {
      const ref = yield* archiveRef("capture", input.sessionID)
      const state = yield* captureSnapshot("capture", input)
      const snapshot = state.snapshot
      const hasChanges = changed(snapshot)
      const existing = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (existing) {
        const archived = yield* readSnapshot("capture", input, ref).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (archived && same(snapshot, archived.snapshot)) {
          const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
          if (current !== archived.oid)
            return yield* failed("capture", `archive ref ${ref} changed during capture retry`)
          return { ref, oid: archived.oid, snapshot, hasChanges, ignored: state.ignored } satisfies CaptureResult
        }
      }

      const index = yield* commit(
        "capture",
        input,
        snapshot.indexTree,
        [snapshot.baseCommit],
        `${input.sessionID} archived index`,
      )
      const untracked =
        snapshot.untrackedTree || snapshot.ignoredTree
          ? yield* commit(
              "capture",
              input,
              snapshot.untrackedTree ?? EMPTY_TREE,
              [],
              `${input.sessionID} archived untracked files`,
            )
          : undefined
      const ignored = snapshot.ignoredTree
        ? yield* commit(
            "capture",
            input,
            snapshot.ignoredTree,
            [],
            JSON.stringify({
              version: 1,
              mode: snapshot.ignoredMode,
              directories: snapshot.ignoredDirectories ?? [],
            }),
          )
        : undefined
      const oid = yield* commit(
        "capture",
        input,
        snapshot.workingTree,
        [snapshot.baseCommit, index, ...(untracked ? [untracked] : []), ...(ignored ? [ignored] : [])],
        `${input.sessionID} archived worktree`,
      )
      yield* run("capture", input.directory, ["update-ref", ref, oid, existing ?? MISSING_OID])

      const final = yield* captureSnapshot("capture", input)
      if (!same(snapshot, final.snapshot)) {
        return yield* failed("capture", "worktree changed while the archive ref was finalized")
      }
      const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (current !== oid) return yield* failed("capture", `archive ref ${ref} changed while capture was finalized`)
      return { ref, oid, snapshot, hasChanges, ignored: state.ignored } satisfies CaptureResult
    })

    const baseCommit = Effect.fn("WorktreeArchive.baseCommit")(function* (input: ClearInput) {
      const ref = yield* archiveRef("restore", input.sessionID)
      const expected = yield* readSnapshot("restore", input, ref)
      if (expected.oid !== input.oid) {
        return yield* failed("restore", `archive ref ${ref} changed after lifecycle persistence`)
      }
      const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (current !== input.oid) return yield* failed("restore", `archive ref ${ref} changed while reading its base`)
      return expected.snapshot.baseCommit
    })

    const restore = Effect.fn("WorktreeArchive.restore")(function* (input: RestoreInput) {
      const ref = yield* archiveRef("restore", input.sessionID)
      const currentRef = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (!currentRef) {
        const expected = yield* readSnapshotAt("restore", input, input.oid)
        const live = yield* captureSnapshot("restore", input, expected.snapshot.ignoredMode ?? "legacy")
        if (!same(live.snapshot, expected.snapshot)) {
          return yield* failed("restore", `archive ref ${ref} is missing and the restored worktree changed`)
        }
        return {
          ref,
          oid: input.oid,
          snapshot: expected.snapshot,
          alreadyApplied: true,
        } satisfies RestoreResult
      }
      const expected = yield* readSnapshot("restore", input, ref)
      if (expected.oid !== input.oid) {
        return yield* failed("restore", `archive ref ${ref} changed after lifecycle persistence`)
      }
      const live = yield* captureSnapshot("restore", input, expected.snapshot.ignoredMode ?? "legacy")
      if (live.snapshot.baseCommit !== expected.snapshot.baseCommit) {
        return yield* failed("restore", "preserved branch no longer matches the archived base commit")
      }
      if (same(live.snapshot, expected.snapshot)) {
        const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
        if (current !== input.oid) return yield* failed("restore", `archive ref ${ref} changed during restoration`)
        return {
          ref,
          oid: expected.oid,
          snapshot: expected.snapshot,
          alreadyApplied: true,
        } satisfies RestoreResult
      }
      const missing = yield* missingIgnored("restore", input, live.snapshot, expected.snapshot)
      const coreApplied = sameCore(live.snapshot, expected.snapshot)
      if (!coreApplied && changedCore(live.snapshot)) {
        return yield* failed("restore", "worktree differs from both the archived snapshot and its clean base")
      }

      if (!coreApplied) yield* run("restore", input.directory, ["stash", "apply", "--index", input.oid])
      yield* restoreIgnored(input, expected.snapshot, missing).pipe(Effect.scoped)
      const restored = yield* captureSnapshot("restore", input, expected.snapshot.ignoredMode ?? "legacy")
      if (!same(restored.snapshot, expected.snapshot)) {
        return yield* failed("restore", "restored worktree did not match the archived snapshot")
      }
      const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (current !== input.oid) return yield* failed("restore", `archive ref ${ref} changed during restoration`)
      return {
        ref,
        oid: expected.oid,
        snapshot: expected.snapshot,
        alreadyApplied: coreApplied && missing.files.length === 0 && missing.directories.length === 0,
      } satisfies RestoreResult
    })

    const verify = Effect.fn("WorktreeArchive.verify")(function* (input: RestoreInput) {
      const ref = yield* archiveRef("verify", input.sessionID)
      const current = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (current !== input.oid)
        return yield* failed("verify", `archive ref ${ref} no longer matches its persisted oid`)
      const expected = yield* readSnapshotAt("verify", input, input.oid)
      const live = yield* captureSnapshot("verify", input, expected.snapshot.ignoredMode ?? "legacy")
      if (!same(live.snapshot, expected.snapshot)) {
        return yield* failed("verify", "worktree changed after the archive snapshot was persisted")
      }
      const final = yield* optional(input.directory, ["rev-parse", "--verify", "--quiet", ref])
      if (final !== input.oid) return yield* failed("verify", `archive ref ${ref} changed during verification`)
      return { ref, oid: input.oid, snapshot: expected.snapshot } satisfies VerifyResult
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

    return Service.of({ preview, capture, baseCommit, verify, restore, clear })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Git.node, FSUtil.node] })

export * as WorktreeArchive from "./archive"
