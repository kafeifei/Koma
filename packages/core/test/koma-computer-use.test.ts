import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  configuration,
  codexConfiguration,
  createComputerUse,
  permissionState,
  read,
  save,
} from "../src/koma-computer-use"
import { computerUseStatus, COMPUTER_USE_SERVER } from "../src/koma-computer-use-types"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(
  permissions: object = { accessibility: true, screen_recording: true, source: { attribution: "driver-daemon" } },
  registration?: (file: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "koma-cua-test-"))
  roots.push(root)
  const calls: string[][] = []
  const service = createComputerUse({
    root,
    platform: "darwin",
    device: "Test Mac",
    findBinary: () => "/test/cua-driver",
    run: async (file, args) => {
      calls.push([file, ...args])
      if (args[0] === "--version") return "cua-driver 0.28.1\n"
      if (args[0] === "permissions" && args[1] === "status") return JSON.stringify(permissions)
      if (args.includes("__permissions-host-request")) {
        const result = args[args.indexOf("--result-file") + 1]!
        expect((await stat(result)).mode & 0o777).toBe(0o600)
        if (registration) await registration(result)
        else
          await writeFile(
            result,
            JSON.stringify({
              structuredContent: {
                ...permissions,
                source: { attribution: "driver-daemon", bundle_id: "com.trycua.driver" },
              },
            }),
          )
      }
      return "{}"
    },
  })
  return { root, calls, service }
}

describe("computer control", () => {
  test("status only probes version and attributed permissions, with no startup or grants", async () => {
    const { service, calls, root } = await fixture()
    const status = await service.request({ action: "status" })
    expect(status).toMatchObject({
      device: "Test Mac",
      version: "0.28.1",
      enabled: false,
      running: true,
      accessibility: true,
    })
    expect(calls.map((call) => call.slice(1))).toEqual([["--version"], ["permissions", "status", "--json"]])
    expect(read(root)).toEqual({ enabled: false })
    expect(configuration(root)).toBeUndefined()
  })

  test("never treats host grants or daemon absence as the driver's own grants", () => {
    for (const value of [
      { accessibility: true, screen_recording: true, source: { attribution: "host" } },
      { accessibility: true, screen_recording: true },
      { daemon_running: false, status: "unknown" },
    ])
      expect(permissionState(value)).toEqual({ running: false, accessibility: null, screenRecording: null })
  })

  test("requires both permissions before enabling; disabling remains possible", async () => {
    const { service, root } = await fixture({
      accessibility: true,
      screen_recording: false,
      source: { attribution: "driver-daemon" },
    })
    await expect(service.request({ action: "enable", enabled: true })).rejects.toThrow("grant Accessibility")
    expect(read(root).enabled).toBe(false)
    await save(root, true, "/test/cua-driver")
    expect((await service.request({ action: "enable", enabled: false })).enabled).toBe(false)
  })

  test("shares one managed configuration with both engines and preserves other settings", async () => {
    const { service, root } = await fixture()
    await save(root, false)
    const custom = '{"mcp":{"personal":{"type":"local","command":["personal-tool"]}}}'
    await writeFile(join(root, "config/opencode.json"), custom)
    await service.request({ action: "enable", enabled: true })
    expect(configuration(root)).toMatchObject({ command: ["/test/cua-driver", "mcp"], enabled: true })
    expect(codexConfiguration(root)).toMatchObject({
      [`mcp_servers.${COMPUTER_USE_SERVER}`]: { command: "/test/cua-driver", args: ["mcp"], enabled: true },
    })
    await service.request({ action: "enable", enabled: false })
    expect(configuration(root)?.enabled).toBe(false)
    expect(codexConfiguration(root)[`mcp_servers.${COMPUTER_USE_SERVER}`]?.enabled).toBe(false)
    expect(await readFile(join(root, "config/opencode.json"), "utf8")).toBe(custom)
  })

  test("existing installation and running daemon are never replaced or restarted", async () => {
    const { service, calls } = await fixture()
    await service.request({ action: "install" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await service.request({ action: "start" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      calls.every((call) => call[0] === "/test/cua-driver" && ["--version", "permissions"].includes(call[1]!)),
    ).toBe(true)
  })

  test("invalid actions do not run commands; unsupported hosts report their own identity", async () => {
    const { service, calls, root } = await fixture()
    await expect(service.request({ action: "enable", enabled: "true" })).rejects.toThrow()
    await expect(service.request({ action: "shell", command: "whoami" })).rejects.toThrow()
    await expect(service.request({ action: "open-settings", permission: "file:///tmp" })).rejects.toThrow()
    await expect(service.request({ action: "open-settings" })).rejects.toThrow()
    expect(calls).toHaveLength(0)
    const linux = createComputerUse({ root, platform: "linux", device: "Remote Linux", findBinary: () => undefined })
    expect(await linux.status()).toMatchObject({ supported: false, device: "Remote Linux", platform: "linux" })
    await expect(linux.request({ action: "install" })).rejects.toThrow("macOS")
    await expect(linux.request({ action: "open-settings", permission: "accessibility" })).rejects.toThrow("macOS")
  })

  test("a missing permission is registered before its settings open, while existing grants only open settings", async () => {
    const { service, calls, root } = await fixture({
      accessibility: true,
      screen_recording: false,
      source: { attribution: "driver-daemon" },
    })
    for (const permission of ["accessibility", "screenRecording"] as const) {
      const state = await service.request({ action: "open-settings", permission })
      expect(state).toMatchObject({ accessibility: true, screenRecording: false, enabled: false })
    }
    const opens = calls.filter((call) => call[0] === "/usr/bin/open")
    const result = opens[1]!.at(-1)!
    expect(opens).toEqual([
      ["/usr/bin/open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"],
      [
        "/usr/bin/open",
        "-n",
        "-W",
        "-g",
        "/Applications/CuaDriver.app",
        "--args",
        "__permissions-host-request",
        "--result-file",
        result,
      ],
      ["/usr/bin/open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"],
    ])
    await expect(stat(result)).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      calls.every(
        (call) =>
          call[0] === "/usr/bin/open" ||
          call.slice(1).join(" ") === "--version" ||
          call.slice(1).join(" ") === "permissions status --json",
      ),
    ).toBe(true)
    expect(read(root)).toEqual({ enabled: false })
  })

  test("missing Accessibility is also registered without waiting for either permission to be enabled", async () => {
    const { service, calls } = await fixture({
      accessibility: false,
      screen_recording: false,
      source: { attribution: "driver-daemon" },
    })
    expect(await service.request({ action: "open-settings", permission: "accessibility" })).toMatchObject({
      accessibility: false,
      screenRecording: false,
      enabled: false,
    })
    const opens = calls.filter((call) => call[0] === "/usr/bin/open")
    expect(opens).toHaveLength(2)
    expect(opens[0]).toContain("__permissions-host-request")
    expect(opens[1]).toEqual([
      "/usr/bin/open",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    ])
    expect(calls.flat()).not.toContain("--probe-direct-capture")
    expect(calls.flat()).not.toContain("grant")
    expect(calls.flat()).not.toContain("serve")
  })

  test("failed or incorrectly attributed registration stays visible, cleans up, and does not open settings", async () => {
    for (const response of [
      new Error("helper unavailable"),
      "{}",
      JSON.stringify({
        structuredContent: {
          accessibility: true,
          screen_recording: true,
          source: { attribution: "host", bundle_id: "com.trycua.driver" },
        },
      }),
    ]) {
      let result = ""
      const { service, calls, root } = await fixture(
        {
          accessibility: true,
          screen_recording: false,
          source: { attribution: "driver-daemon" },
        },
        async (file) => {
          result = file
          if (response instanceof Error) throw response
          await writeFile(file, response)
        },
      )
      await expect(service.request({ action: "open-settings", permission: "screenRecording" })).rejects.toThrow(
        "Could not request CuaDriver system permissions",
      )
      expect(calls.filter((call) => call[0] === "/usr/bin/open")).toHaveLength(1)
      await expect(stat(result)).rejects.toMatchObject({ code: "ENOENT" })
      const state = await service.status()
      expect(state.busy).toBeUndefined()
      expect(state).toMatchObject({
        enabled: false,
        error: expect.stringContaining("Could not request CuaDriver"),
      })
      expect(read(root).enabled).toBe(false)
      // A failed attempt releases the action lock so a user can retry.
      await expect(service.request({ action: "open-settings", permission: "screenRecording" })).rejects.toThrow(
        "Could not request CuaDriver system permissions",
      )
    }
  })

  test("an absent installation cannot open an empty permission list", async () => {
    const { root } = await fixture()
    const calls: string[] = []
    const service = createComputerUse({
      root,
      platform: "darwin",
      findBinary: () => undefined,
      run: async (file) => {
        calls.push(file)
        return "{}"
      },
    })
    await expect(service.request({ action: "open-settings", permission: "screenRecording" })).rejects.toThrow(
      "Install Cua Driver first",
    )
    expect(calls).toEqual([])
  })

  test("installation starts a stopped driver through LaunchServices before reporting readiness", async () => {
    const { root } = await fixture()
    let installed = false
    let running = false
    const calls: string[][] = []
    const service = createComputerUse({
      root,
      platform: "darwin",
      findBinary: () => (installed ? "/test/cua-driver" : undefined),
      run: async (file, args) => {
        calls.push([file, ...args])
        if (file === "/bin/bash") installed = true
        if (file === "/usr/bin/open") running = true
        if (args[0] === "--version") return "cua-driver 0.28.1"
        return JSON.stringify({ daemon_running: running, source: { attribution: "driver-daemon" } })
      },
    })
    await service.request({ action: "install" })
    let state = await service.status()
    for (let attempt = 0; state.busy && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      state = await service.status()
    }
    expect(state).toMatchObject({ installed: true, running: true, enabled: false })
    expect(state.busy).toBeUndefined()
    const installer = calls.findIndex((call) => call[0] === "/bin/bash")
    const launch = calls.findIndex((call) => call[0] === "/usr/bin/open")
    expect(installer).toBeGreaterThan(-1)
    expect(launch).toBeGreaterThan(installer)
    expect(calls[launch]).toEqual([
      "/usr/bin/open",
      "-g",
      "-a",
      "/Applications/CuaDriver.app",
      "--args",
      "serve",
      "--no-permissions-gate",
    ])
  })

  test("a failed probe remains unknown and blocks enablement", async () => {
    const { root } = await fixture()
    const service = createComputerUse({
      root,
      platform: "darwin",
      findBinary: () => "/test/cua-driver",
      run: async () => {
        throw new Error("probe failed")
      },
    })
    const state = await service.status()
    expect(state.accessibility).toBeNull()
    expect(computerUseStatus(state)).toBe("error")
    await expect(service.request({ action: "enable", enabled: true })).rejects.toThrow()
  })
})
