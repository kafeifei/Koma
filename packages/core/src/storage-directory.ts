import fs from "node:fs"
import path from "node:path"
import { StoragePaths } from "./storage-paths"

// Migration aliases preserve durable directory identities, not filesystem security boundaries.
// Only worktrees recorded before the move retain their old logical directory.
export function resolve(directory: string, root = process.env.OPENCODE_HOME?.trim()) {
  if (!root) return directory
  const worktrees = StoragePaths.metadata(root)?.worktrees
  if (!worktrees?.length) return directory
  const physical = canonical(directory)
  for (const worktree of worktrees) {
    const suffix = path.relative(canonical(worktree.path), physical)
    if (suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${path.sep}`) && !path.isAbsolute(suffix))) {
      return path.join(worktree.directory, suffix)
    }
  }
  return directory
}

function canonical(directory: string): string {
  const absolute = path.resolve(directory)
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute)
  const parent = path.dirname(absolute)
  if (parent === absolute) return absolute
  return path.join(canonical(parent), path.basename(absolute))
}

export * as StorageDirectory from "./storage-directory"
