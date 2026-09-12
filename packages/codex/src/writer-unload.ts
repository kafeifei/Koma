import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CodexRuntime } from "./session"
import type { v2 } from "./protocol/generated"

type Recovery = { threadID: string; restore: string[]; archived: boolean }

/** 0.153.4 retains unsubscribed writers for 30 minutes. Archive unloads immediately.
 * Record the exact previously unarchived family before touching native storage.
 * Koma Session archival is unchanged; interrupted recovery completes on takeover retry.
 */
export async function unloadWriter(runtime: CodexRuntime, home: string, threadID: string, recoverOnly = false) {
  const directory = path.join(home, "koma-handoffs")
  const file = recoveryFile(home, threadID)
  const previous = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!previous && recoverOnly) return false
  let recovery: Recovery
  if (previous) {
    recovery = JSON.parse(previous)
    if (
      recovery.threadID !== threadID ||
      !Array.isArray(recovery.restore) ||
      !recovery.restore.every((id) => typeof id === "string")
    )
      throw new Error("Invalid native handoff recovery record; task was preserved")
  } else {
    const restore = [threadID]
    let cursor: string | null | undefined
    do {
      const page = await runtime.client.request<"thread/list", v2.ThreadListResponse>("thread/list", {
        ancestorThreadId: threadID,
        archived: false,
        modelProviders: [],
        sourceKinds: [
          "cli",
          "vscode",
          "exec",
          "appServer",
          "subAgent",
          "subAgentReview",
          "subAgentCompact",
          "subAgentThreadSpawn",
          "subAgentOther",
          "unknown",
        ],
        cursor,
        limit: 100,
      })
      for (const child of page.data) {
        const current = await runtime.readThread(child.id, true)
        if (
          current.thread.status.type === "active" ||
          current.thread.turns.some(
            (turn) =>
              turn.status === "inProgress" ||
              turn.items.some((item) => "status" in item && item.status === "inProgress"),
          )
        )
          throw new Error("A native child task is still running; stop it before taking over this parent task")
        restore.push(child.id)
      }
      cursor = page.nextCursor
    } while (cursor)
    recovery = { threadID, restore: [...new Set(restore)], archived: false }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await save()
  }
  if (!recovery.archived) {
    // An archive acknowledgement may have been lost before the marker advanced.
    const current = await runtime.readThread(threadID, false)
    if (!current.thread.path?.split(/[\\/]/).includes("archived_sessions"))
      await runtime.client.request("thread/archive", { threadId: threadID }, { timeoutMs: 5_000 })
    recovery.archived = true
    await save()
  }
  for (const id of recovery.restore) {
    const response = await runtime.client.request<"thread/unarchive", v2.ThreadUnarchiveResponse>("thread/unarchive", {
      threadId: id,
    })
    if (response.thread.id !== id)
      throw new Error("Codex restored a different native thread; handoff recovery was preserved")
  }
  await rm(file)
  return true

  async function save() {
    const temporary = `${file}.tmp`
    await writeFile(temporary, JSON.stringify(recovery), { mode: 0o600 })
    await rename(temporary, file)
  }
}

function recoveryFile(home: string, threadID: string) {
  return path.join(home, "koma-handoffs", `${createHash("sha256").update(threadID).digest("hex")}.json`)
}

export async function hasWriterRecovery(home: string, threadID: string) {
  return readFile(recoveryFile(home, threadID)).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
}
