import fs from "node:fs"
import { join } from "node:path"

// Electron must supply original-fs: its regular fs treats .asar as a directory.
export function snapshotRuntimeResources(source: string, temp: string, io: typeof fs) {
  const owner = io.mkdtempSync(join(temp, "opencode-runtime-"))
  const root = join(owner, "app.asar")
  const dispose = () => io.rmSync(owner, { recursive: true, force: true })
  try {
    const before = io.statSync(source)
    io.copyFileSync(source, root, io.constants.COPYFILE_FICLONE)
    if (io.existsSync(`${source}.unpacked`)) {
      io.cpSync(`${source}.unpacked`, `${root}.unpacked`, {
        recursive: true,
        dereference: true,
        mode: io.constants.COPYFILE_FICLONE,
      })
    }
    const after = io.statSync(source)
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Application resources changed while preparing the runtime")
    }
    return { root, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
