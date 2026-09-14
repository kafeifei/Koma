import { execFileSync } from "node:child_process"
import { copyFile, mkdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { CODEX_RUNTIME_ARCHIVE, codexRuntimePackage } from "../../codex/src/runtime-package"
import { sha256, unpackCodexRuntime } from "../../codex/src/binary"

export async function prepareCodexRuntime(repository: string) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repository,
    encoding: "utf8",
  }).trim()
  const cache = join(common, "koma-build-cache", "codex-runtime")
  await mkdir(cache, { recursive: true })
  const pkg = codexRuntimePackage()
  const archive = join(cache, `${pkg.sha256}.tar.gz`)
  if ((await sha256(archive).catch(() => undefined)) !== pkg.sha256) {
    const temporary = `${archive}.${randomUUID()}.tmp`
    try {
      const child = Bun.spawn(["curl", "-fL", "--retry", "2", "--max-time", "300", pkg.url, "-o", temporary], {
        stdout: "inherit",
        stderr: "inherit",
      })
      if ((await child.exited) !== 0) throw new Error("Codex runtime download failed")
      if ((await sha256(temporary)) !== pkg.sha256) throw new Error("Codex runtime download checksum mismatch")
      await rename(temporary, archive)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  await unpackCodexRuntime(archive, cache)
  const resources = join(repository, "packages/desktop/resources")
  await mkdir(resources, { recursive: true })
  await copyFile(archive, join(resources, CODEX_RUNTIME_ARCHIVE))
  await copyFile(join(repository, "packages/codex/src/protocol/LICENSE"), join(resources, "koma-codex-LICENSE"))
  console.log(`Prepared verified Codex runtime (${pkg.target}, ${pkg.sha256.slice(0, 12)})`)
}

if (import.meta.main) await prepareCodexRuntime(join(import.meta.dir, "../../.."))
