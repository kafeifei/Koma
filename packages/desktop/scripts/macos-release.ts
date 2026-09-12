import { execFileSync } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { basename, join } from "node:path"

export function assertReleaseSource(cwd: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
  if (git("rev-parse", "HEAD") !== git("rev-parse", "refs/heads/main") || git("status", "--porcelain"))
    throw new Error("Koma release builds require a clean checkout at the main commit.")
}

export function notaryCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.APPLE_KEYCHAIN_PROFILE)
    return [
      "--keychain-profile",
      env.APPLE_KEYCHAIN_PROFILE,
      ...(env.APPLE_KEYCHAIN ? ["--keychain", env.APPLE_KEYCHAIN] : []),
    ]
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
    return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER]
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
    return ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID]
  throw new Error(
    "Configure APPLE_KEYCHAIN_PROFILE, or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER for notarization",
  )
}

async function run(args: string[]) {
  const child = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  if ((await child.exited) !== 0) throw new Error(`${args[0]} ${args[1]} failed`)
}

export async function notarizeAndArchive(app: string, output: string, filename: string) {
  const credentials = notaryCredentials()
  await mkdir(output, { recursive: true })
  const submission = join(output, `${basename(app)}.notarization.zip`)
  const archive = join(output, filename)
  await run(["codesign", "--verify", "--deep", "--strict", app])
  await run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, submission])
  try {
    await run(["xcrun", "notarytool", "submit", submission, ...credentials, "--wait", "--output-format", "json"])
    // Staple before producing the downloadable ZIP so offline Gatekeeper can verify it.
    await run(["xcrun", "stapler", "staple", app])
    await run(["xcrun", "stapler", "validate", app])
    await run(["spctl", "--assess", "--type", "execute", "--verbose=2", app])
    await run(["ditto", "-c", "-k", "--zlibCompressionLevel", "9", "--sequesterRsrc", "--keepParent", app, archive])
  } finally {
    await rm(submission, { force: true })
  }
  console.log(`Release ZIP: ${archive}`)
}
