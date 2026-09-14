import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"
import { desktopIdentity, resolveDesktopChannel } from "./src/main/channel"
import { checkRemotePackage } from "./scripts/check-remote-package"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = resolveDesktopChannel(process.env.OPENCODE_CHANNEL)
const release = channel === "lab" && process.env.KOMA_RELEASE === "1"
const identity = desktopIdentity(channel, release)
if (release && !process.env.APPLE_KEYCHAIN_PROFILE && !process.env.APPLE_API_KEY && !process.env.APPLE_ID) {
  throw new Error(
    "Koma releases require Apple notarization credentials; use APPLE_KEYCHAIN_PROFILE or Apple API credentials",
  )
}

const getBase = (appId: string): Configuration => ({
  artifactName: "Koma-Electron-${version}-${os}-${arch}.${ext}",
  compression: release ? "maximum" : "normal",
  directories: {
    output: release ? "dist-release" : channel === "lab" ? "dist-debug" : "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/opencode-cli*",
    "!resources/koma*",
    // Keep maps in the build output for debugging/Sentry, outside downloadable releases.
    ...(release ? ["!out/**/*.map", "!node_modules/**/*.map"] : []),
  ],
  extraResources: [
    ...(channel === "lab" ? [{ from: "resources/", to: "", filter: ["koma", "koma.exe"] }] : []),
    ...(channel === "lab"
      ? [{ from: "resources/", to: "", filter: ["koma-codex-runtime.tar.gz", "koma-codex-LICENSE"] }]
      : []),
    // Koma uses its own CLI. Only the upstream development channel uses the legacy v2 CLI.
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: identity.name,
    schemes: [identity.scheme],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig(): Configuration {
  const appId = identity.appId
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: identity.name,
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "koma-debug", fpm: [metainfoFpm(appId)] },
      }
    }
    case "lab": {
      return {
        ...base,
        appId,
        productName: identity.name,
        afterPack: async (context) => {
          if (context.electronPlatformName !== "darwin") return
          await checkRemotePackage(
            path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
            context.packager.appInfo.productFilename,
          )
        },
        mac: {
          ...base.mac,
          target: release ? ["zip"] : ["dir"],
          // A certificate keeps Keychain access stable across Lab updates; ad-hoc signatures do not.
          forceCodeSigning: true,
          // Local Lab builds are not notarized and can be signed offline.
          timestamp: release ? undefined : "none",
          hardenedRuntime: release,
          notarize: release,
        },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "koma", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: identity.name,
        protocols: { name: identity.name, schemes: [identity.scheme] },
        publish: { provider: "github", owner: "kafeifei", repo: "Koma", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "koma", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: identity.name,
        protocols: { name: identity.name, schemes: [identity.scheme] },
        publish: { provider: "github", owner: "kafeifei", repo: "Koma", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "koma", fpm: [metainfoFpm(appId)] },
      }
    }
  }
}

export default getConfig()
