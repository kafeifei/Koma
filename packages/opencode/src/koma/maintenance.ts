import { lstat, readlink, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { KomaProfile } from "@opencode-ai/core/koma-profile"

// Removing the terminal entry does not transfer ownership of the shared profile
// to the CLI. Published binaries remain available to a running backend.
export async function uninstall(root: string, args: string[]) {
  if (args.some((arg) => !["--dry-run", "--yes", "-y", "--keep-data", "--keep-config"].includes(arg))) {
    throw new Error("Koma uninstall accepts --dry-run or --yes; shared data is always preserved")
  }
  const lease = await StorageMigration.lock(root)
  try {
    const name = process.platform === "win32" ? "koma.exe" : "koma"
    const target = join(root, "bin", name)
    const shellName = KomaProfile.commandName() + (process.platform === "win32" ? ".exe" : "")
    const shell = join(homedir(), ".local", "bin", shellName)
    const current = await link(target)
    if (
      current !== undefined &&
      !new RegExp(`^\\.koma/[a-f0-9]{64}/${name.replace(".", "\\.")}$`).test(current.replaceAll("\\", "/"))
    ) {
      throw new Error(`CLI entry is not managed by Koma: ${target}`)
    }
    const external = await link(shell)
    if (external !== undefined && resolve(join(homedir(), ".local", "bin"), external) !== target) {
      throw new Error(`Shell entry is not managed by this Koma profile: ${shell}`)
    }
    const paths = [external === undefined ? undefined : shell, current === undefined ? undefined : target].filter(
      (path): path is string => path !== undefined,
    )
    if (!args.includes("--dry-run")) for (const path of paths) await unlink(path)
    console.log(
      JSON.stringify(
        { removed: args.includes("--dry-run") ? [] : paths, planned: paths, sharedDataPreserved: true },
        null,
        2,
      ),
    )
  } finally {
    await lease.release()
  }
}

async function link(path: string) {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!entry) return
  if (!entry.isSymbolicLink()) throw new Error(`Refusing to remove an independent executable: ${path}`)
  return readlink(path)
}
