import { mkdir, copyFile, chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { packageRoot, repository, testRoot } from "./paths"

const mode = process.argv[2]
if (mode !== "dev" && mode !== "build") throw new Error("Use dev or build")
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This first validation build targets macOS Apple Silicon")
const env = { ...process.env, OPENCODE_CHANNEL: "lab", CARGO_BUILD_JOBS: "4" }

async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${args[0]} exited with status ${code}`)
}

// Electron and Tauri consume the exact same verified Koma CLI artifact.
await run([process.execPath, "scripts/build-koma-cli.ts"], join(repository, "packages/desktop"))
const binaries = join(packageRoot, "src-tauri/binaries")
await mkdir(binaries, { recursive: true })
const binary = join(binaries, "koma-aarch64-apple-darwin")
const source = join(repository, "packages/desktop/resources/koma")
await copyFile(source, binary)
await chmod(binary, 0o755)
if (!Buffer.from(await Bun.file(source).arrayBuffer()).equals(Buffer.from(await Bun.file(binary).arrayBuffer())))
  throw new Error("Tauri and Electron Koma CLI artifacts differ")
const cli = await Bun.file(join(repository, "packages/desktop/resources/koma.build.json")).json()
const git = (args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim()
const commit = git(["rev-parse", "HEAD"])
const info = {
  commit,
  dirty: !!git(["status", "--porcelain"]),
  mode,
  builtAt: new Date().toISOString(),
  profile: "KOMA_HOME or the existing ~/.koma",
  instance: "tauri",
  backendSha256: cli.sha256,
  bun: Bun.version,
  backendVersion: execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim(),
  backendBytes: Bun.file(binary).size,
}
await writeFile(join(binaries, "build-info.json"), JSON.stringify(info, null, 2))
await mkdir(join(testRoot, "results"), { recursive: true })
await writeFile(join(testRoot, "results", "tauri-build.json"), JSON.stringify(info, null, 2))
await run(
  [join(packageRoot, "node_modules/.bin/tauri"), mode, ...(mode === "build" ? ["--bundles", "app"] : [])],
  packageRoot,
)
if (mode === "build") {
  const app = join(packageRoot, "src-tauri/target/release/bundle/macos/Koma Tauri Debug.app")
  await run(["codesign", "--force", "--deep", "--sign", "-", app], packageRoot)
  await run(["codesign", "--verify", "--deep", "--strict", app], packageRoot)
}
