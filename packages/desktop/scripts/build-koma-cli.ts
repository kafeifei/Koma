import { $ } from "bun"
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { getCurrentCli } from "./utils"
import pkg from "../package.json"

// Both desktop hosts package this one artifact. Reuse only if the source,
// build version, Bun runtime and binary digest still match.
const target = getCurrentCli()
if (target.os !== process.platform || target.cpu !== process.arch)
  throw new Error("Local Koma CLI packaging requires the native platform and architecture")
const repository = join(import.meta.dir, "../../..")
const git = (args: string[]) => execFileSync("git", args, { cwd: repository })
const version = process.env.OPENCODE_VERSION ?? pkg.version
const release = process.env.KOMA_RELEASE === "1"
const fingerprint = createHash("sha256")
  .update(git(["rev-parse", "HEAD"]))
  .update(git(["diff", "HEAD"]))
  .update(`${Bun.version}:${version}:${process.platform}:${process.arch}:${release}`)
for (const file of git(["ls-files", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean)) {
  fingerprint.update(file).update(await readFile(join(repository, file)))
}
const sourceIdentity = fingerprint.digest("hex")
const platform = process.platform === "win32" ? "windows" : process.platform
const suffix = process.platform === "win32" ? ".exe" : ""
const source = join(import.meta.dir, `../../opencode/dist/opencode-${platform}-${process.arch}/bin/opencode${suffix}`)
const destination = join(import.meta.dir, `../resources/koma${suffix}`)
const manifest = join(import.meta.dir, "../resources/koma.build.json")
const previous = await Bun.file(manifest)
  .json()
  .catch(() => undefined)
const digest = async () =>
  createHash("sha256")
    .update(await readFile(destination))
    .digest("hex")
if (previous?.sourceIdentity === sourceIdentity && previous.sha256 === (await digest().catch(() => undefined))) {
  console.log(`Reusing verified Koma CLI ${previous.version} (${previous.sha256.slice(0, 12)})`)
} else {
  await $`OPENCODE_CHANNEL=lab OPENCODE_VERSION=${version} bun script/build.ts --single --skip-install --skip-embed-web-ui`.cwd(
    join(import.meta.dir, "../../opencode"),
  )
  await copyFile(source, destination)
  if (process.platform !== "win32") await chmod(destination, 0o755)
  if (process.platform === "darwin") await $`codesign --force --sign - ${destination}`
  await writeFile(
    manifest,
    JSON.stringify(
      {
        sourceIdentity,
        version,
        release,
        sha256: await digest(),
        bun: Bun.version,
        commit: git(["rev-parse", "HEAD"]).toString().trim(),
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
}
