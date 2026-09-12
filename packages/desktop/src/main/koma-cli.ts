import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, rename, rm, symlink, unlink } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { StorageMigration } from "@opencode-ai/core/storage-migration"

export async function installKomaCli(input: {
  source: string
  root: string
  linkDirectory?: string
  linkName?: "koma" | "koma-debug"
}) {
  const root = StoragePaths.resolve(input.root).root
  const lease = await StorageMigration.lock(root)
  try {
    const name = process.platform === "win32" ? "koma.exe" : "koma"
    const directory = join(root, "bin")
    const managed = join(directory, ".koma")
    const target = join(directory, name)
    const shellName = (input.linkName ?? "koma") + (process.platform === "win32" ? ".exe" : "")
    const requested = input.linkDirectory ? join(resolve(input.linkDirectory), shellName) : undefined
    const link = requested === target ? undefined : requested
    for (const path of [root, directory, managed]) await checkDirectory(path)
    const previous = await checkTarget(directory, name)
    if (link) await checkShellLink(link, target)

    const hash = await digest(input.source)
    const version = join(managed, hash)
    const binary = join(version, name)
    await checkDirectory(version)
    const existing = await entry(binary)
    if (existing) await checkBinary(binary, hash)
    await mkdir(managed, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(directory, ".install-"))
    let created: { ino: number; dev: number } | undefined
    try {
      if (!existing) {
        await mkdir(join(staging, "version"))
        const candidate = join(staging, "version", name)
        await copyFile(input.source, candidate)
        if ((await digest(candidate)) !== hash)
          throw new Error(`CLI source changed during installation: ${input.source}`)
        if (process.platform !== "win32") await chmod(candidate, 0o555)
        // Never rewrite a published version: already running processes retain their original executable.
        if (await entry(version)) throw new Error(`CLI version directory already exists: ${version}`)
        await rename(join(staging, "version"), version)
      }
      const candidate = join(staging, "current")
      await symlink(join(".koma", hash, name), candidate, "file")
      if (link) {
        await mkdir(resolve(input.linkDirectory!), { recursive: true })
        created = await symlink(target, link, "file").then(
          async () => {
            const current = await lstat(link)
            return { ino: current.ino, dev: current.dev }
          },
          async (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error
            await checkShellLink(link, target)
            return undefined
          },
        )
      }
      const current = await entry(target)
      if (current?.ino !== previous?.ino || current?.dev !== previous?.dev || current?.mode !== previous?.mode) {
        throw new Error(`CLI destination changed during installation: ${target}`)
      }
      // All fallible preparation, including the shell entry, finishes before this single version switch.
      await rename(candidate, target)
      return link ?? target
    } catch (error) {
      if (link && created) {
        const current = await entry(link)
        if (current?.isSymbolicLink() && current.ino === created.ino && current.dev === created.dev) {
          await unlink(link)
        }
      }
      throw error
    } finally {
      // Staging cleanup must not report an installation failure after the version switch succeeded.
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  } finally {
    await lease.release()
  }
}

async function checkTarget(directory: string, name: string) {
  const target = join(directory, name)
  const current = await entry(target)
  if (!current) return
  if (!current.isSymbolicLink()) throw new Error(`CLI destination already exists: ${target}`)
  const link = await readlink(target)
  const parts = link.split(sep)
  if (parts.length !== 3 || parts[0] !== ".koma" || !/^[a-f0-9]{64}$/.test(parts[1]!) || parts[2] !== name) {
    throw new Error(`CLI destination is not managed by Koma: ${target}`)
  }
  await checkDirectory(join(directory, ".koma", parts[1]!))
  await checkBinary(join(directory, link), parts[1]!)
  return current
}

async function checkBinary(binary: string, hash: string) {
  const current = await entry(binary)
  if (!current?.isFile() || (await digest(binary)) !== hash) {
    throw new Error(`CLI version content does not match its managed identity: ${binary}`)
  }
  if (process.platform !== "win32" && !(current.mode & 0o111))
    throw new Error(`CLI version is not executable: ${binary}`)
}

async function checkDirectory(path: string) {
  const current = await entry(path)
  if (current && !current.isDirectory()) throw new Error(`CLI directory is not an owned directory: ${path}`)
}

async function checkShellLink(link: string, target: string) {
  const current = await entry(link)
  if (!current) return
  if (!current.isSymbolicLink() || resolve(link, "..", await readlink(link)) !== target) {
    throw new Error(`CLI destination already exists: ${link}`)
  }
}

async function entry(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}

async function digest(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}
