import { expect, test } from "bun:test"
import { rm, stat } from "node:fs/promises"
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

test("Lab keeps every backend XDG directory under its desktop data root", () => {
  const userDataPath = join("/Users", "tester", "Library", "Application Support", "OpenCode Lab")
  const root = join(userDataPath, "backend")
  expect(labBackendEnvironment(userDataPath)).toEqual({
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  })
})

test("Lab creates its backend roots and removes state bypasses", async () => {
  const userDataPath = join(tmpdir(), `opencode-lab-environment-${process.pid}`)
  const environment: NodeJS.ProcessEnv = {
    OPENCODE_CONFIG: "/formal/config.json",
    OPENCODE_AUTH_CONTENT: "secret",
    OPENCODE_DB: "/formal/opencode.db",
    OPENCODE_PORT: "4096",
    OPENAI_API_KEY: "provider-key",
  }
  const paths = prepareLabEnvironment(environment, userDataPath)

  expect(environment.OPENCODE_CONFIG).toBeUndefined()
  expect(environment.OPENCODE_AUTH_CONTENT).toBeUndefined()
  expect(environment.OPENCODE_DB).toBeUndefined()
  expect(environment.OPENCODE_PORT).toBeUndefined()
  expect(environment.OPENAI_API_KEY).toBe("provider-key")
  expect(environment.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
  expect(environment.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
  await expect(
    Promise.all(Object.values(paths).map((path) => stat(path))).then((items) =>
      items.every((item) => item.isDirectory()),
    ),
  ).resolves.toBe(true)
  await rm(userDataPath, { recursive: true, force: true })
})
