import { expect, test } from "bun:test"
import {
  directoryInputID,
  composerInput,
  prefillDirectoryInput,
  removeLegacyDrafts,
  resolveInputDirectory,
} from "@/context/input-retention"
import type { Platform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import type { Tab } from "@/context/tabs"
import { createDraftStore } from "@/utils/draft-store"
import { Persist, removePersisted } from "@/utils/persist"
import { ServerScope } from "@/utils/server-scope"
import { createRoot } from "solid-js"
import { createPromptSession, createPromptState } from "@/context/prompt-state"

test("the window composer reuses its input across targets and keeps its permission choice", () => {
  const server = ServerConnection.Key.make("sidecar")
  const original = composerInput([], { server, directory: "/first", permissionMode: "full" })
  const switched = composerInput([original], { server: ServerConnection.Key.make("remote"), directory: "C:\\second\\" })
  expect(switched.draftID).toBe(original.draftID)
  expect(switched.directory).toBe("C:/second")
  expect(switched.permissionMode).toBe("full")
  expect(composerInput([], { server, directory: "/first" }).draftID).not.toBe(original.draftID)
})

test("an existing composer can reopen offline, but the same path on another server must resolve", async () => {
  const server = ServerConnection.Key.make("sidecar")
  const tab = composerInput([], { server, directory: "/repo" })
  const input = {
    directory: "/repo",
    scope: ServerScope.local,
    server,
    tabs: [tab],
    resolve: async () => {
      throw new Error("offline")
    },
  }
  expect(await resolveInputDirectory(input)).toBe("/repo")
  await expect(resolveInputDirectory({ ...input, server: ServerConnection.Key.make("remote") })).rejects.toThrow(
    "offline",
  )
})

test("directory inputs use existing server scopes and normalized actual paths", () => {
  const local = directoryInputID(ServerScope.local, "C:\\project\\feature\\")
  expect(local).toBe(directoryInputID(ServerScope.local, "C:/project/feature"))
  expect(local).not.toBe(directoryInputID(ServerScope.local, "C:/project"))
  expect(local).not.toBe(directoryInputID("remote" as ServerScope, "C:/project/feature"))
  expect(directoryInputID(ServerScope.local, "/")).not.toBe(directoryInputID(ServerScope.local, ""))
})

test("known directory input remains available offline with its permission metadata", async () => {
  const tab: Tab = {
    type: "draft",
    server: "sidecar" as ServerConnection.Key,
    directory: "/old/worktree",
    draftID: directoryInputID(ServerScope.local, "/old/worktree"),
    permissionMode: "full",
  }
  expect(
    await resolveInputDirectory({
      directory: tab.directory,
      scope: ServerScope.local,
      tabs: [tab],
      resolve: async () => {
        throw new Error("offline")
      },
    }),
  ).toBe(tab.directory)
  expect(tab.permissionMode).toBe("full")
})

test("unknown physical directory resolves before choosing the retained input key", async () => {
  const directory = await resolveInputDirectory({
    directory: "/new/worktrees/old",
    scope: ServerScope.local,
    tabs: [],
    resolve: async () => "/old/worktree",
  })
  expect(directoryInputID(ServerScope.local, directory)).toBe(directoryInputID(ServerScope.local, "/old/worktree"))
  await expect(
    resolveInputDirectory({
      directory: "/unknown",
      scope: ServerScope.local,
      tabs: [],
      resolve: async () => {
        throw new Error("offline")
      },
    }),
  ).rejects.toThrow("offline")
})

test("legacy cleanup deletes only UUID documents through the scoped store API", async () => {
  const server = "sidecar" as ServerConnection.Key
  const documents = new Map<string, string>()
  const removed: string[] = []
  const draftStore = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => {
      documents.set(key, value)
    },
    remove: async (key) => {
      removed.push(key)
      documents.delete(key)
    },
    putBlob: async () => "synthetic-blob",
    getBlob: async () => null,
  })
  const platform: Platform = {
    platform: "web",
    openExternal() {},
    restart: async () => {},
    notify: async () => {},
    draftStore,
  }
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    directoryInputID(ServerScope.local, "/repo"),
  ]
  const tabs: Tab[] = ids.map((draftID) => ({
    type: "draft",
    server,
    directory: "/repo",
    draftID,
    permissionMode: "full",
  }))
  const key = (target: ReturnType<typeof Persist.draft>) => `${target.storage}:${target.key}`
  const keys = ids.map((id) => key(Persist.draft(id, "prompt")))
  const sessionKey = key(Persist.serverSession(ServerScope.local, "encoded-repo", "ses-kept", "prompt"))
  for (const item of [...keys, sessionKey])
    await draftStore.setItem(item, JSON.stringify({ prompt: [{ type: "image", blob: { id: "synthetic-blob" } }] }))
  const session: Tab = { type: "session", server, sessionId: "ses-kept" }
  const retained = await removeLegacyDrafts([...tabs, session], platform)
  expect(retained).toEqual([tabs[2]!, session])
  expect(removed).toEqual(keys.slice(0, 2))
  expect([...documents.keys()]).toEqual([keys[2]!, sessionKey])
  expect(await removeLegacyDrafts(retained, platform)).toEqual(retained)
  expect(removed).toHaveLength(2)
})

test("legacy cleanup waits for document deletion before dropping its metadata", async () => {
  const gate = Promise.withResolvers<void>()
  const tab: Tab = {
    type: "draft",
    server: "sidecar" as ServerConnection.Key,
    directory: "/repo",
    draftID: "11111111-1111-4111-8111-111111111111",
  }
  let completed = false
  const cleanup = Promise.resolve(
    removeLegacyDrafts(
      [tab],
      deletionPlatform(() => gate.promise),
    ),
  ).then((tabs) => {
    completed = true
    return tabs
  })
  try {
    await Promise.resolve()
    expect(completed).toBe(false)
  } finally {
    gate.resolve()
  }
  expect(await cleanup).toEqual([])
})

test("rejected legacy deletion keeps only the unfinished metadata for the next hydration", async () => {
  const gate = Promise.withResolvers<void>()
  // Also handle the original promise so the pre-fix fire-and-forget implementation can be tested safely.
  void gate.promise.catch(() => {})
  const tabs: Tab[] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"].map(
    (draftID) => ({ type: "draft", server: "sidecar" as ServerConnection.Key, directory: "/repo", draftID }),
  )
  const removed: string[] = []
  const platform = deletionPlatform((key) => {
    removed.push(key)
    return key.includes("11111111") ? gate.promise : Promise.resolve()
  })
  const cleanup = Promise.resolve(removeLegacyDrafts(tabs, platform))
  gate.reject(new Error("Synthetic storage rejection"))
  const retained = await cleanup
  expect(retained).toEqual([tabs[0]!])
  expect(
    await removeLegacyDrafts(
      retained,
      deletionPlatform(async (key) => {
        removed.push(key)
      }),
    ),
  ).toEqual([])
  expect(removed.filter((key) => key.includes("22222222"))).toHaveLength(1)
})

test("removePersisted completion includes asynchronous prompt and desktop metadata deletion", async () => {
  const prompt = Promise.withResolvers<void>()
  const metadata = Promise.withResolvers<void>()
  const platform = deletionPlatform(() => prompt.promise)
  platform.platform = "desktop"
  platform.storage = () => ({
    getItem: async () => null,
    setItem: async () => {},
    removeItem: () => metadata.promise,
  })
  let completed = false
  const removal = Promise.resolve(removePersisted(Persist.prompt(Persist.draft("test", "prompt")), platform)).then(
    () => {
      completed = true
    },
  )
  try {
    prompt.resolve()
    await Promise.resolve()
    expect(completed).toBe(false)
  } finally {
    metadata.resolve()
  }
  await removal
  expect(completed).toBe(true)
})

test("ordinary reopening does not change a cached input, while explicit prefill appends in order", async () => {
  const session = createPromptState()
  await prefillDirectoryInput(session, "First")
  const first = session.current()
  await prefillDirectoryInput(session)
  await prefillDirectoryInput(session, "")
  expect(session.current()).toBe(first)
  await prefillDirectoryInput(session, "Second")
  expect(
    session
      .current()
      .flatMap((part) => ("content" in part ? [part.content] : []))
      .join(""),
  ).toBe("First\n\nSecond")
  session.reset()
  await prefillDirectoryInput(session, "After sending")
  expect(
    session
      .current()
      .flatMap((part) => ("content" in part ? [part.content] : []))
      .join(""),
  ).toBe("After sending")
})

test("prefill waits for hydration and preserves file positions, images and context", async () => {
  const gate = Promise.withResolvers<string | null>()
  const platform = deletionPlatform(async () => {})
  platform.draftStore!.getItem = () => gate.promise
  const { session, dispose } = createRoot((dispose) => ({
    session: createPromptSession(
      ServerScope.local,
      { draftID: directoryInputID(ServerScope.local, "/prefill") },
      undefined,
      platform,
    ),
    dispose,
  }))
  const file = { type: "file", path: "src/file.ts", content: "@file.ts", start: 4, end: 12 }
  const image = {
    type: "image",
    id: "attachment",
    filename: "kept.png",
    mime: "image/png",
    blob: { id: "kept", url: "blob:kept" },
  }
  const context = { type: "file", path: "src/context.ts", key: "context" }
  const prefill = prefillDirectoryInput(session, "Prefill")
  expect(session.ready()).toBe(false)
  expect(session.dirty()).toBe(false)
  gate.resolve(
    JSON.stringify({
      prompt: [{ type: "text", content: "See ", start: 0, end: 4 }, file, image],
      cursor: 12,
      context: { items: [context] },
    }),
  )
  await prefill
  expect(session.current().slice(0, 3)).toEqual([{ type: "text", content: "See ", start: 0, end: 4 }, file, image])
  expect(session.current().at(-1)).toEqual({ type: "text", content: "\n\nPrefill", start: 12, end: 21 })
  expect(session.cursor()).toBe(21)
  expect(session.context.items()).toEqual([context])
  dispose()
})

function deletionPlatform(removeItem: (key: string) => Promise<void>): Platform {
  return {
    platform: "web",
    openExternal() {},
    restart: async () => {},
    notify: async () => {},
    draftStore: {
      getItem: async () => null,
      setItem: async () => {},
      removeItem,
      putBlob: async () => ({ id: "synthetic", url: "blob:synthetic" }),
    },
  }
}
