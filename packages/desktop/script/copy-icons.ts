import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

// Koma: `koma` selects Koma's icons, which every packaged build uses; the dev run keeps the channel's.
const src = arg === "koma" ? "./icons/koma" : `./icons/${channel}`

const dest = "resources/icons"

await $`rm -rf ${dest}`

await $`cp -R ${src} ${dest}`

console.log(`Copied ${channel} icons from ${src} to ${dest}`)
