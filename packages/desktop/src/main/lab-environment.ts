import { mkdirSync } from "node:fs"
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
] as const

export function labBackendEnvironment(userDataPath: string) {
  const root = join(userDataPath, "backend")
  return {
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  }
}

export function prepareLabEnvironment(environment: NodeJS.ProcessEnv, userDataPath: string) {
  const paths = labBackendEnvironment(userDataPath)
  Object.values(paths).forEach((path) => mkdirSync(path, { recursive: true }))
  bypassVariables.forEach((key) => delete environment[key])
  Object.assign(environment, paths, {
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  })
  return paths
}
