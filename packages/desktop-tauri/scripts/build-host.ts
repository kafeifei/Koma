import { mkdir, copyFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

// The remote transport runs on Node in both hosts. Bun's node:http upgrade
// compatibility cannot preserve this transport's raw duplex streams.
const version = "22.23.2"
const filename = `node-v${version}-darwin-arm64.tar.gz`
const root = join(import.meta.dir, "../../../.local/desktop-tests/node-runtime")
const directory = join(import.meta.dir, "../src-tauri/binaries")
await mkdir(root, { recursive: true })
await mkdir(directory, { recursive: true })
const archive = join(root, filename)
const base = `https://nodejs.org/dist/v${version}`
const checksumFile = join(root, "SHASUMS256.txt")
if (!(await Bun.file(checksumFile).exists()))
  execFileSync("curl", ["-fsSL", "--max-time", "60", `${base}/SHASUMS256.txt`, "-o", checksumFile])
const checksums = await Bun.file(checksumFile).text()
const sha = checksums
  .split("\n")
  .find((line) => line.endsWith(`  ${filename}`))
  ?.split(" ")[0]
if (!sha) throw new Error("Missing Node runtime checksum")
if (!(await Bun.file(archive).exists()))
  execFileSync("curl", ["-fsSL", "--max-time", "180", `${base}/${filename}`, "-o", archive])
if (
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex") !== sha
)
  throw new Error("Node checksum mismatch")
const extract = Bun.spawn(["tar", "-xzf", archive, "-C", root], { stdout: "inherit", stderr: "inherit" })
if ((await extract.exited) !== 0) throw new Error("Node extraction failed")
const unpacked = join(root, `node-v${version}-darwin-arm64`)
await copyFile(join(unpacked, "bin/node"), join(directory, "node"))
await copyFile(join(unpacked, "LICENSE"), join(directory, "node-LICENSE"))
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "host-entry.ts")],
  target: "node",
  format: "cjs",
  outdir: directory,
  naming: "host.cjs",
  minify: true,
})
if (!build.success) throw new AggregateError(build.logs, "Desktop host bundle failed")
