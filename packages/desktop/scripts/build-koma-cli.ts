import { $ } from "bun"
import { chmod, copyFile, readFile, writeFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { getCurrentCli } from "./utils"
import pkg from "../package.json"
import { komaBuildInputs } from "./koma-build-inputs"
import { prepareCodexRuntime } from "./prepare-codex-runtime"

// Both desktop hosts package this one artifact. Reuse only if the source,
// build version, Bun runtime and binary digest still match.
const target = getCurrentCli()
if (target.os !== process.platform || target.cpu !== process.arch)
  throw new Error("Local Koma CLI packaging requires the native platform and architecture")
const repository = join(import.meta.dir, "../../..")
await prepareCodexRuntime(repository)
const git = (args: string[]) => execFileSync("git", args, { cwd: repository })
const version = process.env.OPENCODE_VERSION ?? pkg.version
const release = process.env.KOMA_RELEASE === "1"
const started = performance.now()
const sourceIdentity = await komaBuildInputs(repository, {
  bun: Bun.version,
  version,
  platform: process.platform,
  arch: process.arch,
  release,
  modelsUrl: process.env.OPENCODE_MODELS_URL ?? "https://models.dev",
  modelsSnapshot: process.env.MODELS_DEV_API_JSON
    ? createHash("sha256")
        .update(await readFile(process.env.MODELS_DEV_API_JSON))
        .digest("hex")
    : undefined,
})
const platform = process.platform === "win32" ? "windows" : process.platform
const suffix = process.platform === "win32" ? ".exe" : ""
const source = join(import.meta.dir, `../../opencode/dist/opencode-${platform}-${process.arch}/bin/opencode${suffix}`)
const destination = join(import.meta.dir, `../resources/koma${suffix}`)
const manifest = join(import.meta.dir, "../resources/koma.build.json")
const cacheRoot = join(
  git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim(),
  "koma-build-cache",
  "cli",
)
const cache = join(cacheRoot, sourceIdentity)
const digest = async (file = destination) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
let previous = await Bun.file(manifest)
  .json()
  .catch(() => undefined)
if (previous?.sourceIdentity !== sourceIdentity || previous.sha256 !== (await digest().catch(() => undefined))) {
  const saved = await Bun.file(join(cache, "manifest.json"))
    .json()
    .catch(() => undefined)
  if (
    saved?.sourceIdentity === sourceIdentity &&
    saved.sha256 === (await digest(join(cache, "koma")).catch(() => undefined))
  ) {
    await copyFile(join(cache, "koma"), destination)
    await writeFile(manifest, JSON.stringify(saved, null, 2))
    previous = saved
  }
}
if (previous?.sourceIdentity === sourceIdentity && previous.sha256 === (await digest().catch(() => undefined))) {
  console.log(`Reusing verified Koma CLI ${previous.version} (${previous.sha256.slice(0, 12)})`)
  await writeFile(
    manifest,
    JSON.stringify({ ...previous, validatedCommit: git(["rev-parse", "HEAD"]).toString().trim() }, null, 2),
  )
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
// Publish atomically for the next clean main checkout. Never trust a cache hit
// without checking both its source identity and the executable's SHA-256.
await mkdir(cacheRoot, { recursive: true })
const staging = await mkdtemp(join(cacheRoot, ".tmp-"))
try {
  await copyFile(destination, join(staging, "koma"))
  await copyFile(manifest, join(staging, "manifest.json"))
  await rename(staging, cache).catch((error) => {
    if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error
  })
} finally {
  await rm(staging, { recursive: true, force: true })
}
console.log(`Koma CLI preparation: ${((performance.now() - started) / 1000).toFixed(2)}s`)
