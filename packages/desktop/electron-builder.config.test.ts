import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"
import { resolveChannel } from "./scripts/utils"

const channels = [
  { channel: "dev", appId: "com.kafeifei.koma.debug" },
  { channel: "lab", appId: "com.kafeifei.koma.debug" },
  { channel: "beta", appId: "com.kafeifei.koma" },
  { channel: "prod", appId: "com.kafeifei.koma" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
  })
}

test("keeps the Lab app independent from production", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "lab"
  const module = await import("./electron-builder.config.ts?identity=lab")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.productName).toBe("Koma Debug")
  expect(config.directories?.output).toBe("dist-debug")
  expect(config.protocols).toEqual({ name: "Koma Debug", schemes: ["koma-debug"] })
  expect(config.publish).toBeUndefined()
  expect(config.mac?.identity).toBeUndefined()
  expect(config.mac?.forceCodeSigning).toBe(true)
  expect(config.mac?.hardenedRuntime).toBe(false)
  expect(config.mac?.notarize).toBe(false)
  expect(config.files).toContain("!resources/koma*")
  expect(config.extraResources).toContainEqual({ from: "resources/", to: "", filter: ["koma", "koma.exe"] })
})

test("falls back to the environment channel for invalid resource arguments", () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"
  expect(resolveChannel("invalid")).toBe("prod")
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous
})

test("Koma release packages the Lab runtime with hardened signing and notarization", async () => {
  const previous = { ...process.env }
  try {
    process.env.OPENCODE_CHANNEL = "lab"
    process.env.KOMA_RELEASE = "1"
    process.env.APPLE_KEYCHAIN_PROFILE = "test-notary-profile"
    const { default: config } = await import("./electron-builder.config.ts?koma=release")
    expect(config.productName).toBe("Koma")
    expect(config.directories?.output).toBe("dist-release")
    expect(config.mac?.target).toEqual(["zip"])
    expect(config.artifactName).toBe("Koma-Electron-${version}-${os}-${arch}.${ext}")
    expect(config.compression).toBe("maximum")
    expect(config.files).toContain("!out/**/*.map")
    expect(config.files).toContain("!node_modules/**/*.map")
    expect(config.extraResources).not.toContainEqual({ from: "resources/", to: "", filter: ["opencode-cli*"] })
    expect(config.mac?.forceCodeSigning).toBe(true)
    expect(config.mac?.hardenedRuntime).toBe(true)
    expect(config.mac?.timestamp).toBeUndefined()
    expect(config.mac?.notarize).toBe(true)
    expect(config.publish).toBeUndefined()
    expect(config.extraResources).toContainEqual({ from: "resources/", to: "", filter: ["koma", "koma.exe"] })
  } finally {
    for (const key of ["OPENCODE_CHANNEL", "KOMA_RELEASE", "APPLE_KEYCHAIN_PROFILE"]) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})

for (const channel of ["dev"] as const) {
  test(`bundles the CLI outside the ${channel} app archive`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.files).toContain("!resources/opencode-cli*")
    expect(config.extraResources).toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
  })
}

test("Koma packages only its shared CLI without the unused upstream v2 executable", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "lab"
  try {
    const { default: config } = await import("./electron-builder.config.ts?koma=single-cli")
    expect(config.extraResources).toContainEqual({ from: "resources/", to: "", filter: ["koma", "koma.exe"] })
    expect(config.extraResources).toContainEqual({
      from: "resources/",
      to: "",
      filter: [
        "koma-codex-runtime.tar.gz",
        "koma-codex-LICENSE",
        "koma-codex-NOTICE",
        "koma-codex-THIRD-PARTY-NOTICES",
      ],
    })
    expect(config.extraResources).not.toContainEqual({ from: "resources/", to: "", filter: ["opencode-cli*"] })
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous
  }
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
    expect(config.extraResources).not.toContainEqual({ from: "resources/", to: "", filter: ["koma", "koma.exe"] })
  })
}
