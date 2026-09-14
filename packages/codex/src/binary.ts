import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import { access, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { CODEX_APP_SERVER_VERSION, CodexVersionMismatchError, readCodexVersion } from "./transport"
import { CODEX_RUNTIME_ARCHIVE, CODEX_RUNTIME_VERSION, codexRuntimePackage } from "./runtime-package"

const run = promisify(execFile)

export async function resolveCodexBinary(input: {
  home: string
  cache: string
  executable?: string
  environment?: NodeJS.ProcessEnv
}) {
  const environment = input.environment ?? process.env
  const configured = environment.OPENCODE_CODEX_BINARY
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("OPENCODE_CODEX_BINARY must be an absolute path")
    return verified(configured)
  }
  const executable = await realpath(input.executable ?? process.execPath)
  const archive = path.join(path.dirname(executable), CODEX_RUNTIME_ARCHIVE)
  if (await present(archive)) return unpackCodexRuntime(archive, input.cache)

  // Source development can use an installed compatible CLI. A newer first PATH
  // entry must not hide a compatible later entry; explicit overrides fail closed.
  const name = process.platform === "win32" ? "codex.exe" : "codex"
  const candidates = [
    ...(environment.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name)),
    path.join(input.home, ".local", "bin", name),
  ]
  const mismatches: string[] = []
  for (const candidate of new Set(candidates)) {
    if (!path.isAbsolute(candidate) || !(await present(candidate, constants.X_OK))) continue
    try {
      return await verified(candidate)
    } catch (error) {
      mismatches.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(
    `Codex ${CODEX_APP_SERVER_VERSION} executable was not found${mismatches.length ? `: ${mismatches.join("; ")}` : ""}`,
  )
}

export async function unpackCodexRuntime(archive: string, cache: string) {
  if (CODEX_RUNTIME_VERSION !== CODEX_APP_SERVER_VERSION) throw new Error("Bundled Codex and protocol versions differ")
  const pkg = codexRuntimePackage()
  const parent = path.join(cache, "codex-runtime")
  const destination = path.join(parent, `${CODEX_RUNTIME_VERSION}-${pkg.sha256}`)
  const binary = path.join(destination, "bin", process.platform === "win32" ? "codex.exe" : "codex")
  if (await present(binary)) return verified(binary)
  if ((await sha256(archive)) !== pkg.sha256) throw new Error("Bundled Codex runtime checksum mismatch")
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(path.join(parent, ".extract-"))
  try {
    await run("tar", ["-xzf", archive, "-C", staging], { timeout: 120_000 })
    await verified(path.join(staging, "bin", process.platform === "win32" ? "codex.exe" : "codex"))
    await rename(staging, destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error
    })
    return await verified(binary)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function sha256(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function verified(binary: string) {
  const version = await readCodexVersion(binary)
  if (version !== CODEX_APP_SERVER_VERSION)
    throw new CodexVersionMismatchError(CODEX_APP_SERVER_VERSION, version, binary)
  return binary
}

async function present(file: string, mode = constants.F_OK) {
  return access(file, mode).then(
    () => true,
    () => false,
  )
}
