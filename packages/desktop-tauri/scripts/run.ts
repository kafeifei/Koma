import { mkdir, copyFile, chmod, writeFile, cp } from "node:fs/promises"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { withKomaBuildSequence } from "../../desktop/scripts/koma-build-sequence"
import { packageRoot, repository, testRoot } from "./paths"
import { assertReleaseSource, notaryCredentials, notarizeAndArchive } from "../../desktop/scripts/macos-release"
import pkg from "../../desktop/package.json"

const mode = process.argv[2]
if (mode !== "dev" && mode !== "build" && mode !== "release") throw new Error("Use dev, build or release")
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Koma Tauri currently targets macOS Apple Silicon")
const release = mode === "release"
if (release) {
  assertReleaseSource(repository)
  notaryCredentials()
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCODE_CHANNEL: "lab",
  OPENCODE_VERSION: pkg.version,
  KOMA_RELEASE: release ? "1" : "0",
  CARGO_BUILD_JOBS: "4",
}
// The common release step signs all nested executables and notarizes the final bundle.
// Do not let the Tauri bundler submit a partially signed app on its own.
for (const key of Object.keys(env)) if (key.startsWith("APPLE_")) delete env[key]
const productName = release ? "Koma Tauri" : "Koma Tauri Debug"
const git = (args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim()
if (git(["branch", "--show-current"]) === "dev") throw new Error("dev only mirrors upstream; build from main")
const identities =
  mode === "dev" ? "" : execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" })
const identity = process.env.CSC_NAME || identities.match(/"(Developer ID Application:[^"]+)"/)?.[1]
if (mode !== "dev" && !identity) throw new Error("Koma requires a Developer ID Application signing certificate")

async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${args[0]} exited with status ${code}`)
}

// Electron and Tauri consume the exact same verified Koma CLI artifact.
await run([process.execPath, "scripts/build-koma-cli.ts"], join(repository, "packages/desktop"))
await run([process.execPath, "scripts/build-host.ts"], packageRoot)
const binaries = join(packageRoot, "src-tauri/binaries")
await mkdir(binaries, { recursive: true })
const binary = join(binaries, "koma-aarch64-apple-darwin")
const source = join(repository, "packages/desktop/resources/koma")
await copyFile(source, binary)
for (const name of [
  "koma-codex-runtime.tar.gz",
  "koma-codex-LICENSE",
  "koma-codex-NOTICE",
  "koma-codex-THIRD-PARTY-NOTICES",
])
  await copyFile(join(repository, "packages/desktop/resources", name), join(binaries, name))
await chmod(binary, 0o755)
if (!Buffer.from(await Bun.file(source).arrayBuffer()).equals(Buffer.from(await Bun.file(binary).arrayBuffer())))
  throw new Error("Tauri and Electron Koma CLI artifacts differ")
const cli = await Bun.file(join(repository, "packages/desktop/resources/koma.build.json")).json()
const commit = git(["rev-parse", "HEAD"])
const info = {
  commit,
  dirty: !!git(["status", "--porcelain"]),
  mode,
  version: pkg.version,
  release,
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
if (mode === "dev") {
  await run([process.execPath, "run", "build:ui"], packageRoot)
  await cp(join(packageRoot, "dist"), join(binaries, "web"), { recursive: true })
  // A development window can stay open for hours. It must not reserve a
  // delivery sequence or block another worktree's Debug/Release build.
  await run([join(packageRoot, "node_modules/.bin/tauri"), "dev"], packageRoot)
  process.exit(0)
}
await withKomaBuildSequence(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), async (sequence) => {
  Object.assign(env, { OPENCODE_LAB_BUILD_SEQUENCE: String(sequence) })
  const config = release
    ? [
        "--config",
        JSON.stringify({
          productName,
          version: pkg.version,
          identifier: "com.kafeifei.koma.tauri",
          bundle: { macOS: { bundleVersion: String(sequence) } },
        }),
      ]
    : []
  await run([join(packageRoot, "node_modules/.bin/tauri"), "build", "--bundles", "app", ...config], packageRoot)
  const app = join(packageRoot, `src-tauri/target/release/bundle/macos/${productName}.app`)
  if (release) {
    const signing = ["codesign", "--force", "--timestamp", "--options", "runtime", "--sign", identity!]
    const entitlements = join(repository, "packages/desktop/resources/entitlements.plist")
    for (const executable of ["Contents/Resources/node", "Contents/MacOS/koma"])
      await run([...signing, "--entitlements", entitlements, join(app, executable)], packageRoot)
    await run([...signing, app], packageRoot)
    await notarizeAndArchive(app, join(packageRoot, "dist-release"), `Koma-Tauri-${pkg.version}-mac-arm64.zip`)
  } else {
    await run(
      ["codesign", "--force", "--timestamp=none", "--sign", identity!, join(app, "Contents/Resources/node")],
      packageRoot,
    )
    await run(["codesign", "--force", "--deep", "--timestamp=none", "--sign", identity!, app], packageRoot)
    await run(["codesign", "--verify", "--deep", "--strict", app], packageRoot)
  }
})
