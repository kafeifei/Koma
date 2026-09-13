import { mkdir, lstat } from "node:fs/promises"
import { join } from "node:path"

// The parent is only the composer's directory context. Each submitted task gets
// its own child. A persisted key makes retries resolve to the same directory.
export async function projectlessWorkspace(state: string, key?: string) {
  if (key !== undefined && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(key))
    throw new Error("Invalid workspace key")
  const root = join(state, "projectless")
  await mkdir(root, { recursive: true })
  const directory = key ? join(root, key) : root
  for (const path of [...new Set([root, directory])]) {
    await mkdir(path, { recursive: true })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace must be a real directory")
  }
  return { directory }
}
