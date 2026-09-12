#!/usr/bin/env bun
import { $ } from "bun"

import { downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

if (channel === "dev") await downloadCliToResources()
if (channel === "lab") await $`bun ./scripts/build-koma-cli.ts`
// CLI packaging clears opencode/dist, so build the desktop backend afterwards.
await $`cd ../opencode && bun script/build-node.ts`
