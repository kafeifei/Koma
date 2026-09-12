import { DatabaseSync } from "node:sqlite"
import { createKomaDraftStore } from "@opencode-ai/core/koma-draft-store"

export function createDesktopDraftStore(filename: string) {
  return createKomaDraftStore(new DatabaseSync(filename))
}
