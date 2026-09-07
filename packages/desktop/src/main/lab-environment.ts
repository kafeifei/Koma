import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { join } from "node:path"

const bypassVariables = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_DB",
  "OPENCODE_MODELS_PATH",
  "OPENCODE_MODELS_URL",
  "OPENCODE_TEST_HOME",
  "OPENCODE_TEST_MANAGED_CONFIG_DIR",
  "OPENCODE_TUI_CONFIG",
  "OPENCODE_PORT",
  "OPENCODE_DISABLE_CHANNEL_DB",
  "OPENCODE_CODEX_HOME",
] as const

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
  const paths = labBackendEnvironment(root)
  bypassVariables.forEach((key) => delete environment[key])
  Object.assign(environment, paths, {
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_ENABLE_CODEX: "1",
  })
  return paths
}
