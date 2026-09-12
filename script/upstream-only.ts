import { execFileSync } from "node:child_process"

const root = new URL("..", import.meta.url)
const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" })
  .trim()
  .replace(/\.git$/, "")
  .toLowerCase()
if (!["https://github.com/anomalyco/opencode", "git@github.com:anomalyco/opencode"].includes(origin)) {
  throw new Error("Upstream publishing is disabled in Koma. Build from main and follow docs/release.md.")
}
