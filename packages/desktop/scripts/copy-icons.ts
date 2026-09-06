import { $ } from "bun"
import { desktopIdentity } from "../src/main/channel"
import { resolveChannel } from "./utils"

const channel = resolveChannel(process.argv[2])

const src = `./icons/${desktopIdentity(channel).icon}`
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied ${channel} icons from ${src} to ${dest}`)
