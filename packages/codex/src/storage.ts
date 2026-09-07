import { createHash } from "node:crypto"
import path from "node:path"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

export function codexStorage(input: { state: string; root?: string; home?: string }) {
  const paths = input.root ? StoragePaths.resolve(input.root) : undefined
  const home = path.resolve(input.home ?? paths?.codex ?? path.join(input.state, "codex"))
  // Moving the native home must not detach durable sessions from their original owner.
  const scope = paths && home === paths.codex ? StoragePaths.metadata(paths.root)?.codexScope : undefined
  return { home, scope: scope ?? `codex:${createHash("sha256").update(home).digest("hex")}` }
}
