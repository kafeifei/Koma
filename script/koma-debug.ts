#!/usr/bin/env bun
// Koma: builds Koma Debug from a clean `main` and installs it into /Applications (see PROJECT.md).
import { $ } from "bun"
import { komaServiceFile } from "../packages/desktop/src/main/koma"
import { buildKoma } from "./koma-build"

const build = await buildKoma({ channel: "dev" })

if (!build.signed)
  console.warn("No Developer ID identity found: the build stays ad-hoc signed and macOS will ask for the Keychain after every build")
const installed = `/Applications/${build.identity.appName}.app`
const running = `application id "${build.identity.appID}" is running`

// Relaunching replaces the running service, which cuts off any session still working. Install only once none is.
for (let notice = true; (await working()) > 0; notice = false) {
  if (notice) console.log(`${build.identity.appName} has a session working; installing once it is idle (Ctrl-C to stop)`)
  await Bun.sleep(5000)
}

const relaunch = (await $`osascript -e ${`return ${running}`}`.quiet().nothrow().text()).trim() === "true"

// A running copy keeps its files open; quit it before replacing the bundle.
await $`osascript -e ${`if ${running} then tell application id "${build.identity.appID}" to quit`}`.quiet().nothrow()

await Bun.sleep(1500)

await $`rm -rf ${installed}`

await $`ditto ${build.app} ${installed}`

// Reopened now, while idle, so its new service takes over before any session starts working again.
if (relaunch) await $`open ${installed}`

console.log(`Installed ${installed} #${build.build} (main at ${build.commit.slice(0, 10)})`)

/** How many of Koma Debug's sessions are working, by its running service; none when no service runs. */
async function working() {
  const registration = Bun.file(komaServiceFile("dev"))

  if (!(await registration.exists())) return 0
  const service: { url: string; password: string } = await registration.json()

  const response = await fetch(`${service.url}/api/session/active`, {
    headers: { authorization: `Basic ${btoa(`opencode:${service.password}`)}` },
  }).catch(() => undefined)

  if (!response?.ok) return 0
  const active: { data: Record<string, unknown> } = await response.json()

  return Object.keys(active.data).length
}
