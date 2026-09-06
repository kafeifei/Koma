export type Mode = "local" | "all"

export type Decision = {
  readonly action: "preserve" | "skip"
  readonly reason: string
}

const REBUILDABLE_SEGMENTS = new Set([
  "node_modules",
  ".pnpm-store",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
])

const REBUILDABLE_PATHS = [
  [".yarn", "cache"],
  [".next", "cache"],
  [".bun", "install", "cache"],
] as const

export function decide(filepath: string, mode: Mode): Decision {
  if (mode === "all") return { action: "preserve", reason: "ignored local content" }
  const segments = filepath.replace(/\/$/, "").split("/")
  if (
    segments.some((segment) => REBUILDABLE_SEGMENTS.has(segment)) ||
    REBUILDABLE_PATHS.some((candidate) =>
      segments.some((_, index) => candidate.every((segment, offset) => segments[index + offset] === segment)),
    )
  ) {
    return { action: "skip", reason: "rebuildable dependency or cache" }
  }
  return { action: "preserve", reason: "ignored local content" }
}

export * as WorktreeIgnoredPolicy from "./ignored-policy"
