#!/usr/bin/env bun
// Koma: builds Koma Debug from a clean `main` and installs it into /Applications (see PROJECT.md).
// The CLI is built for Koma Debug's own channel, so its service and database stay apart from an installed OpenCode's.
import { $ } from "bun"
import { existsSync } from "node:fs"
import path from "node:path"
import { KOMA } from "../packages/desktop/src/main/koma"

if (process.platform !== "darwin") throw new Error("Koma Debug is built and installed on macOS only")

const root = path.resolve(import.meta.dir, "..")
const cli = path.join(root, "packages/cli")
const desktop = path.join(root, "packages/desktop")
const identity = KOMA.dev
const arch = process.arch === "arm64" ? "arm64" : "x64"

const dirty = (await $`git status --porcelain`.cwd(root).text()).trim()

if (dirty) throw new Error(`Koma Debug builds from a clean tree. Commit these first:\n${dirty}`)
const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(root).text()).trim()

if (branch !== "main") throw new Error(`Koma Debug builds from main, not ${branch}. Merge into main first.`)
const commit = (await $`git rev-parse --short HEAD`.cwd(root).text()).trim()

console.log(`Building ${identity.appName} from main at ${commit}`)

await $`bun run build --single --skip-install`.cwd(cli).env({ ...process.env, OPENCODE_CHANNEL: identity.service })

const env = { ...process.env, OPENCODE_CHANNEL: "dev" }

await $`bun run build`.cwd(desktop).env(env)

await $`rm -rf dist`.cwd(desktop)

await $`bunx electron-builder --mac --${arch} --publish never --config electron-builder.config.ts --dir -c.mac.identity=null`
  .cwd(desktop)
  .env(env)

const built = path.join(desktop, "dist", arch === "arm64" ? "mac-arm64" : "mac", `${identity.appName}.app`)

if (!existsSync(built)) throw new Error(`Packaging did not produce ${built}`)
const installed = `/Applications/${identity.appName}.app`

// A running copy keeps its files open; quit it before replacing the bundle. Its service is replaced on next launch.
await $`osascript -e ${`if application id "${identity.appID}" is running then tell application id "${identity.appID}" to quit`}`
  .quiet()
  .nothrow()

await Bun.sleep(1500)

await $`rm -rf ${installed}`

await $`ditto ${built} ${installed}`

console.log(`Installed ${installed} (main at ${commit})`)
