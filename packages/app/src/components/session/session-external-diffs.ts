import type { LabSnapshotOutput } from "@opencode-ai/lab-client"

// Use the message's native turn identity; display order and Git state are not turn identities.
export function getExternalTurnDiff(
  snapshot: Pick<LabSnapshotOutput, "messages" | "turnDiffs"> | undefined,
  messageID: string | undefined,
) {
  const metadata = snapshot?.messages.find((message) => message.id === messageID)?.metadata?.codex
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
  const turnID = "turnID" in metadata ? metadata.turnID : undefined
  if (typeof turnID !== "string") return undefined
  return snapshot?.turnDiffs[turnID]
}
