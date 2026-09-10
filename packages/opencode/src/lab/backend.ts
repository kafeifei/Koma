import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LabBackend } from "@opencode-ai/core/lab-backend"
import { LabEnvironment } from "@opencode-ai/core/lab-environment"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

export async function serve(root: string) {
  LabEnvironment.prepare(process.env, root)
  const owner = await LabBackend.claim(root)
  try {
    const lease = await StorageMigration.lock(root)
    try {
      const legacyRoot =
        root === join(homedir(), ".opencode")
          ? join(homedir(), "Library", "Application Support", "OpenCode Lab")
          : `${root}.legacy`
      const manifest = StoragePaths.metadata(root)
      if (!manifest && existsSync(legacyRoot)) {
        throw new Error("Existing Lab data needs migration. Close the old app and start the updated Lab desktop first.")
      }
      StorageMigration.prepareUnifiedHome({ root, legacyRoot, acquireLock: () => true })
      StorageMigration.reconcileWorktrees({ root, legacyRoot })
      await LabBackend.activate(root)
    } finally {
      await lease.release()
    }
    Object.assign(process.env, { OPENCODE_SERVER_USERNAME: owner.username, OPENCODE_SERVER_PASSWORD: owner.password })
    const { Server } = await import("../server/server")
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, cors: ["oc://renderer"] })
    await owner.ready(`http://127.0.0.1:${listener.port}`)
    console.log(`OpenCode Lab backend listening on http://127.0.0.1:${listener.port}`)
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve)
      process.once("SIGINT", resolve)
    })
    await listener.stop(true)
  } finally {
    await owner.release()
  }
}
