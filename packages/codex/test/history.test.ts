import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"
import { readCodexRolloutHistory } from "../src/history.js"

describe("readCodexRolloutHistory", () => {
  test("reads one bound rollout with stable order and preserved unknown content", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opencode-codex-history-"))
    const path = resolve(home, "sessions", "2026", "09", "06", "rollout.jsonl")
    await mkdir(dirname(path), { recursive: true })
    await cp(fileURLToPath(new URL("./fixture/rollout.jsonl", import.meta.url)), path)
    const history = await readCodexRolloutHistory({
      codexHome: home,
      path,
      expectedThreadID: "thread-fixture",
      runtimeScope: "scope-fixture",
    })
    expect(history.threadID).toBe("thread-fixture")
    expect(history.turns).toHaveLength(1)
    expect(history.turns[0]?.observedStatus).toBe("completed")
    expect(history.turns[0]?.items.map((item) => item.kind)).toEqual(["message", "reasoning"])
    expect(history.turns[0]?.items[0]?.text).toBe("hello")
    expect(history.turns[0]?.usage).toHaveLength(1)
    const again = await readCodexRolloutHistory({
      codexHome: home,
      path,
      expectedThreadID: "thread-fixture",
      runtimeScope: "scope-fixture",
    })
    expect(again.turnOrder).toEqual(history.turnOrder)
    expect(again.turns[0]?.itemOrder).toEqual(history.turns[0]?.itemOrder)
  })

  test("rejects paths outside the injected Codex home", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opencode-codex-home-"))
    await mkdir(resolve(home, "sessions"), { recursive: true })
    await expect(
      readCodexRolloutHistory({
        codexHome: home,
        path: fileURLToPath(new URL("./fixture/rollout.jsonl", import.meta.url)),
        expectedThreadID: "thread-fixture",
        runtimeScope: "scope-fixture",
      }),
    ).rejects.toThrow("outside the injected home")
  })

  test("rejects a rollout bound to another thread", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opencode-codex-history-"))
    const path = resolve(home, "sessions", "rollout.jsonl")
    await mkdir(dirname(path), { recursive: true })
    await cp(fileURLToPath(new URL("./fixture/rollout.jsonl", import.meta.url)), path)
    await expect(
      readCodexRolloutHistory({
        codexHome: home,
        path,
        expectedThreadID: "another-thread",
        runtimeScope: "scope-fixture",
      }),
    ).rejects.toThrow("identity mismatch")
  })
})
