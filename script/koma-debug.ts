#!/usr/bin/env bun
// Koma: builds Koma Debug from a clean `main` and installs it into /Applications (see PROJECT.md).
import { $ } from "bun"
import { buildKoma } from "./koma-build"

const build = await buildKoma({ channel: "dev" })

if (!build.signed)
  console.warn("No Developer ID identity found: the build stays ad-hoc signed and macOS will ask for the Keychain after every build")
const installed = `/Applications/${build.identity.appName}.app`

// A running copy keeps its files open; quit it before replacing the bundle. Its service is replaced on next launch.
await $`osascript -e ${`if application id "${build.identity.appID}" is running then tell application id "${build.identity.appID}" to quit`}`
  .quiet()
  .nothrow()

await Bun.sleep(1500)

await $`rm -rf ${installed}`

await $`ditto ${build.app} ${installed}`

console.log(`Installed ${installed} #${build.build} (main at ${build.commit.slice(0, 10)})`)
