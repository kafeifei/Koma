import { $ } from "bun"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import fs from "node:fs/promises"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import type { WorktreeMerge } from "../../src/worktree/merge"

const state = Layer.effectDiscard(
  Effect.gen(function* () {
    const previous = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = previous
        await resetDatabase()
      }),
    )
  }),
)
const it = testEffect(Layer.mergeAll(state, httpApiLayer))
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})
const git = (directory: string, args: string[]) =>
  Effect.promise(async () => {
    const result = await $`git ${args}`.cwd(directory).quiet()
    return result.text().trim()
  })

describe("worktree management HTTP", () => {
  it.live("reviews explicit conflict choices through HTTP before applying", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => fs.writeFile(`${root}/conflict.txt`, "base\n"))
      yield* git(root, ["add", "."])
      yield* git(root, ["commit", "-m", "conflict base"])
      const created = yield* requestInDirectory("/experimental/worktree", root, json("POST", { wait: true }))
      expect(created.status).toBe(200)
      const entry = (yield* created.json) as { directory: string }
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove --force ${entry.directory}`.cwd(root).quiet().nothrow()).pipe(
          Effect.asVoid,
        ),
      )
      yield* Effect.promise(() => fs.writeFile(`${root}/conflict.txt`, "target\n"))
      yield* git(root, ["commit", "-am", "target change"])
      yield* Effect.promise(() => fs.writeFile(`${entry.directory}/conflict.txt`, "source\n"))
      const before = yield* requestInDirectory(
        "/experimental/worktree/merge/preview",
        root,
        json("POST", { directory: entry.directory }),
      )
      expect(before.status).toBe(200)
      expect(yield* before.json).toMatchObject({ unresolved: ["conflict.txt"], resolutions: [] })
      const resolutions: WorktreeMerge.Resolution[] = [{ path: "conflict.txt", choice: "source" }]
      const reviewed = yield* requestInDirectory(
        "/experimental/worktree/merge/preview",
        root,
        json("POST", { directory: entry.directory, resolutions }),
      )
      expect(reviewed.status).toBe(200)
      const preview = (yield* reviewed.json) as WorktreeMerge.Preview
      expect(preview.unresolved).toEqual([])
      expect(preview.resolutions).toEqual(resolutions)
      expect(yield* Effect.promise(() => fs.readFile(`${root}/conflict.txt`, "utf8"))).toBe("target\n")
      const input = {
        directory: entry.directory,
        resolutions,
        sourceHead: preview.sourceHead,
        sourceTree: preview.sourceTree,
        targetHead: preview.targetHead,
        mergedTree: preview.mergedTree,
      }
      expect((yield* requestInDirectory("/experimental/worktree/merge/apply", root, json("POST", input))).status).toBe(
        400,
      )
      expect(
        (yield* requestInDirectory(
          "/experimental/worktree/merge/apply",
          root,
          json("POST", { ...input, reviewID: preview.reviewID }),
        )).status,
      ).toBe(200)
      expect(yield* Effect.promise(() => fs.readFile(`${root}/conflict.txt`, "utf8"))).toBe("source\n")
      expect(yield* git(root, ["diff", "--cached", "--name-only"])).toBe("conflict.txt")
      expect(yield* Effect.promise(() => fs.readFile(`${entry.directory}/conflict.txt`, "utf8"))).toBe("source\n")
    }),
  )

  it.live(
    "lists real ownership, inspects preservation, previews and applies results, then cleans an unclaimed checkout",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() => fs.writeFile(`${root}/.gitignore`, ".env\nnode_modules/\n"))
        yield* git(root, ["add", "."])
        yield* git(root, ["commit", "-m", "ignore local config"])
        const response = yield* requestInDirectory("/experimental/worktree", root, json("POST", { wait: true }))
        expect(response.status).toBe(200)
        const entry = (yield* response.json) as { directory: string; branch: string }
        const canonical = yield* Effect.promise(() => fs.realpath(entry.directory))
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => $`git worktree remove --force ${entry.directory}`.cwd(root).quiet().nothrow()).pipe(
            Effect.asVoid,
          ),
        )
        yield* Effect.promise(async () => {
          await fs.writeFile(`${entry.directory}/draft.txt`, "result\n")
          await fs.writeFile(`${entry.directory}/.env`, "secret\n")
          await fs.mkdir(`${entry.directory}/node_modules`)
          await fs.writeFile(`${entry.directory}/node_modules/rebuild.txt`, "cache\n")
        })
        const list = yield* requestInDirectory("/experimental/worktree/managed", root)
        expect(list.status).toBe(200)
        expect(yield* list.json).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ directory: canonical, managed: true, orphan: true, primary: false }),
          ]),
        )
        const details = yield* requestInDirectory(
          "/experimental/worktree/details",
          root,
          json("POST", { directory: entry.directory }),
        )
        expect(details.status).toBe(200)
        expect(yield* details.json).toMatchObject({
          space: { errors: 0 },
          ignored: {
            preserved: expect.arrayContaining([expect.objectContaining({ path: ".env" })]),
            skipped: expect.arrayContaining([expect.objectContaining({ path: "node_modules" })]),
          },
        })
        const options = yield* requestInDirectory("/experimental/worktree/options", entry.directory)
        expect(yield* options.json).toMatchObject({ currentBranch: entry.branch })
        const previewResponse = yield* requestInDirectory(
          "/experimental/worktree/merge/preview",
          root,
          json("POST", { directory: entry.directory }),
        )
        expect(previewResponse.status).toBe(200)
        const preview = (yield* previewResponse.json) as WorktreeMerge.Preview
        expect(preview.files).toEqual(["draft.txt"])
        const body = {
          directory: entry.directory,
          sourceHead: preview.sourceHead,
          sourceTree: preview.sourceTree,
          targetHead: preview.targetHead,
          mergedTree: preview.mergedTree,
        }
        const apply = yield* requestInDirectory("/experimental/worktree/merge/apply", root, json("POST", body))
        expect({ status: apply.status, data: yield* apply.json }).toEqual({ status: 200, data: true })
        expect(yield* git(root, ["diff", "--cached", "--name-only"])).toBe("draft.txt")
        expect((yield* requestInDirectory("/experimental/worktree/merge/apply", root, json("POST", body))).status).toBe(
          400,
        )
        expect(
          (yield* requestInDirectory("/experimental/worktree", root, json("DELETE", { directory: entry.directory })))
            .status,
        ).toBe(200)
        const after = yield* requestInDirectory("/experimental/worktree/managed", root)
        expect(yield* after.json).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ directory: canonical })]),
        )
        expect(yield* git(root, ["diff", "--cached", "--name-only"])).toBe("draft.txt")
      }),
  )

  it.live("explicitly adopts an existing task checkout while preserving its user branch", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const directory = root + "-existing"
      yield* git(root, ["worktree", "add", "-b", "user-owned", directory])
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await $`git worktree remove --force ${directory}`.cwd(root).quiet().nothrow()
          await fs.rm(directory, { recursive: true, force: true })
        }),
      )
      const sessionResponse = yield* requestInDirectory("/session", directory, json("POST", { title: "Old checkout" }))
      expect(sessionResponse.status).toBe(200)
      const session = (yield* sessionResponse.json) as { id: string }
      const adopted = yield* requestInDirectory(
        "/experimental/worktree/adopt",
        root,
        json("POST", { directory, sessionID: session.id }),
      )
      expect(adopted.status).toBe(200)
      expect(yield* adopted.json).toMatchObject({ managed: true, owner: { sessionID: session.id } })
      const canonical = yield* Effect.promise(() => fs.realpath(directory))
      expect(
        (yield* requestInDirectory(
          `/session/${session.id}`,
          canonical,
          json("PATCH", { time: { archived: Date.now() } }),
        )).status,
      ).toBe(200)
      const managedFromMissing = yield* requestInDirectory("/experimental/worktree/managed", canonical)
      expect({ status: managedFromMissing.status, body: yield* managedFromMissing.json }).toMatchObject({ status: 200 })
      expect(
        (yield* requestInDirectory(`/session/${session.id}`, canonical, json("PATCH", { time: { archived: null } })))
          .status,
      ).toBe(200)
      expect((yield* requestInDirectory("/experimental/worktree", root, json("DELETE", { directory }))).status).toBe(
        400,
      )
      const deleted = yield* requestInDirectory(`/session/${session.id}`, root, { method: "DELETE" })
      expect({ status: deleted.status, body: yield* deleted.json }).toMatchObject({ status: 200 })
      expect(yield* git(root, ["show-ref", "--verify", "refs/heads/user-owned"])).toContain("refs/heads/user-owned")
    }),
  )
})
