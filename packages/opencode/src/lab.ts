import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { StorageMigration } from "@opencode-ai/core/storage-migration"

// The local fork opts in before loading Global or any database-owning CLI modules.
const paths = StoragePaths.resolve(process.env.OPENCODE_HOME ?? join(homedir(), ".opencode"))
const legacyRoot =
  paths.root === join(homedir(), ".opencode")
    ? join(homedir(), "Library", "Application Support", "OpenCode Lab")
    : `${paths.root}.legacy`
const lease = await StorageMigration.lock(paths.root)
try {
  const manifest = StoragePaths.metadata(paths.root)
  if (manifest?.status !== "complete" && (manifest || existsSync(`${paths.metadata}.tmp`))) {
    throw new Error("OpenCode data migration is incomplete. Start OpenCode Lab to finish it before using this CLI.")
  }
  if (!manifest) {
    if (existsSync(legacyRoot)) {
      throw new Error("Existing Lab data needs migration. Exit the old app and start the updated OpenCode Lab first.")
    }
    StorageMigration.prepareUnifiedHome({
      root: paths.root,
      // An explicitly isolated home must never adopt the installed app's profile.
      legacyRoot,
      acquireLock: () => true,
    })
  }
  StorageMigration.reconcileWorktrees({ root: paths.root, legacyRoot })
  StoragePaths.database(paths.root)
} finally {
  await lease.release()
}
Object.assign(process.env, {
  OPENCODE_HOME: paths.root,
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_ENABLE_CODEX: "1",
})
await import("./index")
