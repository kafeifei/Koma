import { expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { desktopIdentity, desktopUpdaterEnabled, resolveDesktopChannel } from "./channel"
import { labBackendEnvironment, prepareLabEnvironment } from "./lab-environment"

test("Lab has an independent desktop identity and no updater", () => {
  const channel = resolveDesktopChannel("lab")
  expect(desktopIdentity(channel)).toEqual({
    appId: "ai.opencode.lab",
    name: "OpenCode Lab",
    scheme: "opencode-lab",
    icon: "dev",
  })
  expect(desktopUpdaterEnabled(true, channel)).toBe(false)
})

test("Lab uses an explicit home without changing other tools' XDG directories", () => {
  const root = join(tmpdir(), "opencode-lab-home")
  const environment: NodeJS.ProcessEnv = {
    OPENCODE_CONFIG: "/formal/config.json",
    OPENCODE_AUTH_CONTENT: "secret",
    OPENCODE_DB: "/formal/opencode.db",
    OPENCODE_PORT: "4096",
    OPENCODE_CODEX_HOME: "/formal/codex",
    OPENAI_API_KEY: "provider-key",
    XDG_DATA_HOME: "/user/data",
    XDG_CONFIG_HOME: "/user/config",
    XDG_CACHE_HOME: "/user/cache",
    XDG_STATE_HOME: "/user/state",
  }
  expect(labBackendEnvironment(root)).toEqual({ OPENCODE_HOME: root })
  prepareLabEnvironment(environment, root)

  expect(environment.OPENCODE_HOME).toBe(root)
  expect(environment.OPENCODE_CONFIG).toBeUndefined()
  expect(environment.OPENCODE_AUTH_CONTENT).toBeUndefined()
  expect(environment.OPENCODE_DB).toBeUndefined()
  expect(environment.OPENCODE_PORT).toBeUndefined()
  expect(environment.OPENCODE_CODEX_HOME).toBeUndefined()
  expect(environment.OPENCODE_ENABLE_CODEX).toBe("1")
  expect(environment.OPENAI_API_KEY).toBe("provider-key")
  expect(environment.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
  expect(environment.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
  expect(environment.XDG_DATA_HOME).toBe("/user/data")
  expect(environment.XDG_CONFIG_HOME).toBe("/user/config")
  expect(environment.XDG_CACHE_HOME).toBe("/user/cache")
  expect(environment.XDG_STATE_HOME).toBe("/user/state")
})
