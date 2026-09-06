import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Platform } from "./platform"
import type { Tab } from "./tabs"
import { pathKey } from "@/utils/path-key"
import { Persist, draftPersistedKeys, removePersisted } from "@/utils/persist"
import type { ServerScope } from "@/utils/server-scope"
import type { PromptSession } from "./prompt-state"

export function directoryInputID(scope: ServerScope, directory: string) {
  return `input:${base64Encode(JSON.stringify([scope, pathKey(directory)]))}`
}

export function isDirectoryInput(id: string) {
  return id.startsWith("input:")
}

export function isLegacyDraft(tab: Tab) {
  return tab.type === "draft" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(tab.draftID)
}

export async function removeLegacyDrafts(tabs: Tab[], platform: Platform) {
  const retained = await Promise.all(
    tabs.map(async (tab) => {
      if (tab.type !== "draft" || !isLegacyDraft(tab)) return tab
      try {
        await Promise.all(
          draftPersistedKeys().map((key) => {
            const target = Persist.draft(tab.draftID, key)
            return removePersisted(key === "prompt" ? Persist.prompt(target) : target, platform)
          }),
        )
      } catch {
        // Keep the index so the next hydration can finish this upgrade's cleanup.
        return tab
      }
    }),
  )
  return retained.filter((tab): tab is Tab => !!tab)
}

export async function prefillDirectoryInput(session: PromptSession, text?: string) {
  if (!text) return
  await session.ready.promise
  const prompt = session.current()
  const start = prompt.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
  const content = `${start ? "\n\n" : ""}${text}`
  const end = start + content.length
  session.set([...prompt, { type: "text", content, start, end }], end)
}
