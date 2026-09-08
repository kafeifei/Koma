import { $ } from "bun"
import { chmod, copyFile } from "node:fs/promises"
import { join } from "node:path"
import { getCurrentCli } from "./utils"

// Keep the fork's terminal CLI separate from the pinned upstream V2 service binary.
const target = getCurrentCli()
if (target.os !== process.platform || target.cpu !== process.arch) {
  throw new Error("Local Lab CLI packaging requires the native platform and architecture")
}
await $`OPENCODE_CHANNEL=lab bun script/build.ts --single --skip-install --skip-embed-web-ui`.cwd(
  join(import.meta.dir, "../../opencode"),
)
const platform = process.platform === "win32" ? "windows" : process.platform
const suffix = process.platform === "win32" ? ".exe" : ""
const source = join(import.meta.dir, `../../opencode/dist/opencode-${platform}-${process.arch}/bin/opencode${suffix}`)
const destination = join(import.meta.dir, `../resources/opencode-lab${suffix}`)
await copyFile(source, destination)
if (process.platform !== "win32") await chmod(destination, 0o755)
if (process.platform === "darwin") await $`codesign --force --sign - ${destination}`
