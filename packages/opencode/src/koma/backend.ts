import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { KomaProfile } from "@opencode-ai/core/koma-profile"
import { KomaBackend } from "@opencode-ai/core/koma-backend"
import { KomaEnvironment } from "@opencode-ai/core/koma-environment"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

export async function serve(root: string, port = 0) {
  KomaEnvironment.prepare(process.env, root)
  const owner = await KomaBackend.claim(root)
  try {
    const lease = await StorageMigration.lock(root)
    try {
      const legacyRoot = KomaProfile.legacyRoot(root, join(homedir(), "Library", "Application Support", "OpenCode Lab"))
      const manifest = StoragePaths.metadata(root)
      if (!manifest && existsSync(legacyRoot)) {
        throw new Error(
          "Existing Koma data needs migration. Close the old app and start the updated Koma desktop first.",
        )
      }
      StorageMigration.prepareUnifiedHome({ root, legacyRoot, acquireLock: () => true })
      StorageMigration.reconcileWorktrees({ root, legacyRoot })
      await KomaBackend.activate(root)
    } finally {
      await lease.release()
    }
    Object.assign(process.env, { OPENCODE_SERVER_USERNAME: owner.username, OPENCODE_SERVER_PASSWORD: owner.password })
    const { Server } = await import("../server/server")
    const listener = await Server.listen({ hostname: "127.0.0.1", port, cors: ["oc://renderer", "tauri://localhost"] })
    await owner.ready(`http://127.0.0.1:${listener.port}`)
    console.log(`Koma backend listening on http://127.0.0.1:${listener.port}`)
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve)
      process.once("SIGINT", resolve)
    })
    const { stopDesktopServices } = await import("./desktop-services")
    await stopDesktopServices()
    await listener.stop(true)
  } finally {
    await owner.release()
  }
}
