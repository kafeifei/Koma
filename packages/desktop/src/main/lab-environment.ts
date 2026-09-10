import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { LabEnvironment } from "@opencode-ai/core/lab-environment"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { join } from "node:path"

export function labBackendEnvironment(root: string) {
  return { OPENCODE_HOME: StoragePaths.resolve(root).root }
}

// The pinned external V2 CLI predates OPENCODE_HOME. Only that child receives the
// legacy XDG tree; migration keeps its opencode subdirectories linked to the new layout.
export function legacyLabBackendEnvironment(root: string) {
  const paths = StoragePaths.resolve(root)
  return {
    XDG_DATA_HOME: join(paths.desktop, "backend", "data"),
    XDG_CONFIG_HOME: join(paths.desktop, "backend", "config"),
    XDG_CACHE_HOME: join(paths.desktop, "backend", "cache"),
    XDG_STATE_HOME: join(paths.desktop, "backend", "state"),
    OPENCODE_DB: StoragePaths.database(root),
  }
}

export function prepareLabEnvironment(environment: NodeJS.ProcessEnv, root: string) {
  return LabEnvironment.prepare(environment, root)
}

export async function prepareLabDesktopHome(input: {
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
    input.setUserData(StorageMigration.unifiedHomeLockPath(paths))
    return Boolean(StorageMigration.prepareUnifiedHome({ ...paths, acquireLock: input.acquireLock }))
  } finally {
    await lease.release()
  }
}
