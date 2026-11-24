#!/usr/bin/env bun
// Koma: builds a release of Koma Beta (or Koma, with `prod`) from a clean `main` into dist/koma: the signed app as a
// ZIP, and its checksum. Usage: `bun run release <version> [beta|prod]`. Publishing the files is a separate step
// (see PROJECT.md).
import { $ } from "bun"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { buildKoma } from "./koma-build"

const version = process.argv[2] ?? ""

if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Usage: bun run release <version> [beta|prod], e.g. 0.2.0")
const channel = process.argv[3] === "prod" ? "prod" : "beta"
const build = await buildKoma({ channel, version })

if (!build.signed) throw new Error("A release needs a Developer ID Application identity in the keychain")
const out = path.resolve(import.meta.dir, "../dist/koma")
const name = `${build.identity.appName.replaceAll(" ", "-")}-${version}-mac-${build.arch}.zip`

await rm(out, { recursive: true, force: true })

await mkdir(out, { recursive: true })

await $`ditto -c -k --zlibCompressionLevel 9 --sequesterRsrc --keepParent ${build.app} ${path.join(out, name)}`

await Bun.write(path.join(out, "SHA256SUMS.txt"), await $`shasum -a 256 ${name}`.cwd(out).text())

console.log(`Release files in ${out} (${build.identity.appName} ${version}, main at ${build.commit})`)
