import { mkdir, copyFile, chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { assertTestPath, packageRoot, profile, repository, testRoot } from "./paths"

const mode = process.argv[2]
if (mode !== "dev" && mode !== "build") throw new Error("Use dev or build")
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This first validation build targets macOS Apple Silicon")
assertTestPath(profile)
await mkdir(profile, { recursive: true, mode: 0o700 })
const real = await import("node:fs/promises").then((fs) => fs.realpath(profile))
assertTestPath(real)
const env = { ...process.env, OPENCODE_CHANNEL: "lab", OPENCODE_HOME: profile, CARGO_BUILD_JOBS: "4" }

async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${args[0]} exited with status ${code}`)
}

// Build the backend from the same checkout. Never read a running app's resources.
await run(
  [process.execPath, "script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"],
  join(repository, "packages/opencode"),
)
const binaries = join(packageRoot, "src-tauri/binaries")
await mkdir(binaries, { recursive: true })
const binary = join(binaries, "opencode-lab-aarch64-apple-darwin")
await copyFile(join(repository, "packages/opencode/dist/opencode-darwin-arm64/bin/opencode"), binary)
await chmod(binary, 0o755)
await run(["codesign", "--force", "--sign", "-", binary], packageRoot)
const git = (args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim()
const commit = git(["rev-parse", "HEAD"])
const info = {
  commit,
  dirty: !!git(["status", "--porcelain"]),
  mode,
  builtAt: new Date().toISOString(),
  profile,
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
  const app = join(packageRoot, "src-tauri/target/release/bundle/macos/OpenCode Lab Tauri Test.app")
  await run(["codesign", "--force", "--deep", "--sign", "-", app], packageRoot)
  await run(["codesign", "--verify", "--deep", "--strict", app], packageRoot)
}
