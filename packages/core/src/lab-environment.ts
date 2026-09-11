import { StoragePaths } from "./storage-paths"
import { LabExperiments } from "./lab-experiments"

// Both launchers configure the same backend profile. These overrides used to
// let a CLI and Desktop with the same OPENCODE_HOME open different databases.
export function prepare(environment: NodeJS.ProcessEnv, root: string) {
  const paths = StoragePaths.resolve(root)
  for (const key of [
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
  ])
    delete environment[key]
  Object.assign(environment, {
    OPENCODE_HOME: paths.root,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_ENABLE_CODEX: "1",
  })
  const experiments = LabExperiments.read(root)
  if (experiments.backgroundSubagents !== undefined)
    environment.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = String(experiments.backgroundSubagents)
  return { OPENCODE_HOME: paths.root }
}

export * as LabEnvironment from "./lab-environment"
