import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { KomaEnvironment } from "@opencode-ai/core/koma-environment"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { join } from "node:path"

export function komaBackendEnvironment(root: string) {
  return { OPENCODE_HOME: StoragePaths.resolve(root).root }
}

// The pinned external V2 CLI predates OPENCODE_HOME. Only that child receives the
// legacy XDG tree; migration keeps its opencode subdirectories linked to the new layout.
export function legacyKomaBackendEnvironment(root: string) {
  const paths = StoragePaths.resolve(root)
  return {
    XDG_DATA_HOME: join(paths.desktop, "backend", "data"),
    XDG_CONFIG_HOME: join(paths.desktop, "backend", "config"),
    XDG_CACHE_HOME: join(paths.desktop, "backend", "cache"),
    XDG_STATE_HOME: join(paths.desktop, "backend", "state"),
    OPENCODE_DB: StoragePaths.database(root),
  }
}

export function prepareKomaEnvironment(environment: NodeJS.ProcessEnv, root: string) {
  environment.KOMA_BACKEND_INSTANCE = "electron"
  return KomaEnvironment.prepare(environment, root)
}

export async function prepareKomaDesktopHome(input: {
  root: string
  legacyRoot: string
  setUserData: (path: string) => void
  acquireLock: () => boolean
}) {
  const root = StoragePaths.resolve(input.root).root
  const paths = { root, legacyRoot: input.legacyRoot }
  const lease = await StorageMigration.lock(root)
  try {
    const metadata = StoragePaths.metadata(root)
    if (metadata?.status === "complete") {
      input.setUserData(StoragePaths.resolve(root).desktop)
      return input.acquireLock()
    }
    // A deleted home leaves the old desktop alias dangling. Bootstrap under the
    // shared initialization lease before Electron tries to create its singleton
    // directory through that alias. No legacy data is moved in this case.
    if ((!metadata || metadata.source === null) && StorageMigration.isLegacyHomeAlias(paths)) {
      StorageMigration.prepareUnifiedHome({ ...paths, acquireLock: () => true })
      input.setUserData(StoragePaths.resolve(root).desktop)
      return input.acquireLock()
    }
    input.setUserData(StorageMigration.unifiedHomeLockPath(paths))
    return Boolean(StorageMigration.prepareUnifiedHome({ ...paths, acquireLock: input.acquireLock }))
  } finally {
    await lease.release()
  }
}
