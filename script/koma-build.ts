// Koma: builds one channel's Koma app from a clean `main` and signs it (see PROJECT.md). Shared by `koma-debug.ts`,
// which installs the result, and `koma-release.ts`, which archives it.
// The CLI is built for the channel's own service name, so its service and database stay apart from an installed
// OpenCode's and from the other Koma channels'.
import { $ } from "bun"
import { existsSync } from "node:fs"
import path from "node:path"
import { KOMA } from "../packages/desktop/src/main/koma"

const root = path.resolve(import.meta.dir, "..")

/** `version` is the release version; without one the build carries the channel's preview version. */
export async function buildKoma(input: { channel: keyof typeof KOMA; version?: string }) {
  if (process.platform !== "darwin") throw new Error("Koma is built on macOS only")

  const cli = path.join(root, "packages/cli")
  const desktop = path.join(root, "packages/desktop")
  const identity = KOMA[input.channel]
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const dirty = (await $`git status --porcelain`.cwd(root).text()).trim()

  if (dirty) throw new Error(`${identity.appName} builds from a clean tree. Commit these first:\n${dirty}`)
  const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(root).text()).trim()

  if (branch !== "main") throw new Error(`${identity.appName} builds from main, not ${branch}. Merge into main first.`)
  const commit = (await $`git rev-parse HEAD`.cwd(root).text()).trim()
  const version = input.version ? { OPENCODE_VERSION: input.version } : {}
  // Every build of any channel takes the next build number, shown at the foot of the sidebar. The count is kept with
  // the repository's Git data, so worktrees share it, and moves on only once a build succeeds.
  const counter = path.join(
    (await $`git rev-parse --path-format=absolute --git-common-dir`.cwd(root).text()).trim(),
    "koma-build-sequence",
  )
  const build = (existsSync(counter) ? Number((await Bun.file(counter).text()).trim()) : 0) + 1

  console.log(`Building ${identity.appName} ${input.version ?? "(preview)"} #${build} from main at ${commit.slice(0, 10)}`)

  await $`bun run build --single --skip-install`
    .cwd(cli)
    .env({ ...process.env, ...version, OPENCODE_CHANNEL: identity.service })

  const env = { ...process.env, ...version, OPENCODE_CHANNEL: input.channel, KOMA_BUILD: String(build) }

  await $`bun run build`.cwd(desktop).env(env)

  await $`rm -rf dist`.cwd(desktop)

  // The app reports the package version; a release carries its own instead of the upstream one.
  const metadata = input.version ? [`-c.extraMetadata.version=${input.version}`] : []

  await $`bunx electron-builder --mac --${arch} --publish never --config electron-builder.config.ts --dir -c.mac.identity=null ${metadata}`
    .cwd(desktop)
    .env(env)

  const app = path.join(desktop, "dist", arch === "arm64" ? "mac-arm64" : "mac", `${identity.appName}.app`)

  if (!existsSync(app)) throw new Error(`Packaging did not produce ${app}`)

  // An ad-hoc signature changes with every build, so macOS treats each build as another app and asks for the Keychain
  // ("Koma Debug Safe Storage") again and again. A Developer ID signature is the same app across builds, so "Always
  // Allow" holds. The builds are not hardened or notarized.
  const signer = process.env.KOMA_SIGN_IDENTITY ?? (await developerID())

  if (signer) {
    await $`codesign --force --sign ${signer} ${path.join(app, "Contents/Resources/opencode-cli")}`
    await $`codesign --force --deep --sign ${signer} ${app}`
    await $`codesign --verify --deep --strict ${app}`
  }

  await Bun.write(counter, `${build}\n`)

  return { app, arch, build, commit, identity, signed: !!signer }
}

/** The first Developer ID Application identity in the keychain, by hash so that same-named certificates do not clash. */
async function developerID() {
  const identities = await $`security find-identity -v -p codesigning`.nothrow().text()

  return identities.match(/([0-9A-F]{40}) "Developer ID Application:/)?.[1]
}
