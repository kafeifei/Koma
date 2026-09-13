import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

// Follow workspace dependencies instead of Git HEAD: a UI-only commit does not
// change the CLI. Keep whole dependency directories, including prompts/assets.
export async function komaBuildInputs(repository: string, options: Record<string, unknown>) {
  const files = [
    ...new Set(
      execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: repository,
        encoding: "utf8",
      })
        .split("\0")
        .filter(Boolean),
    ),
  ].sort()
  const packages = new Map<string, { directory: string; dependencies: string[] }>()
  for (const file of files.filter((file) => /^packages\/.+\/package\.json$/.test(file))) {
    const pkg = await readFile(join(repository, file), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    if (!pkg) continue
    packages.set(pkg.name, {
      directory: dirname(file),
      dependencies: Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })
        .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
        .map(([name]) => name),
    })
  }
  const directories = new Set<string>()
  function include(name: string) {
    const pkg = packages.get(name)
    if (!pkg) throw new Error(`Missing workspace dependency ${name}`)
    if (directories.has(pkg.directory)) return
    directories.add(pkg.directory)
    pkg.dependencies.forEach(include)
  }
  include("opencode")
  const configuration = new Set([
    "package.json",
    "bun.lock",
    "bun.lockb",
    "bunfig.toml",
    "tsconfig.json",
    ".github/TEAM_MEMBERS",
    "packages/desktop/package.json",
    "packages/desktop/scripts/build-koma-cli.ts",
    "packages/desktop/scripts/koma-build-inputs.ts",
    "packages/desktop/scripts/utils.ts",
  ])
  const selected = files.filter(
    (file) => configuration.has(file) || [...directories].some((dir) => file.startsWith(`${dir}/`)),
  )
  const hash = createHash("sha256").update(JSON.stringify(options))
  // Bound concurrent reads; deterministic ordering also works across worktrees.
  for (let start = 0; start < selected.length; start += 32) {
    const batch = selected.slice(start, start + 32)
    const contents = await Promise.all(
      batch.map((file) =>
        readFile(join(repository, file)).catch((error) => {
          if (error.code === "ENOENT") return undefined
          throw error
        }),
      ),
    )
    for (let i = 0; i < batch.length; i++) {
      hash.update(JSON.stringify([batch[i], contents[i]?.length ?? null]))
      if (contents[i]) hash.update(contents[i]!)
    }
  }
  return hash.digest("hex")
}
