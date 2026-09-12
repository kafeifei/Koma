import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import appPlugin from "@opencode-ai/app/vite"
import pkg from "../app/package.json"

const root = fileURLToPath(new URL("../..", import.meta.url))
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const builtAt = new Date().toISOString()

export default defineConfig({
  plugins: [appPlugin],
  publicDir: "../app/public",
  clearScreen: false,
  define: {
    "import.meta.env.OPENCODE_BUILD": JSON.stringify({
      id: `tauri-test-${builtAt}`,
      version: pkg.version,
      channel: "tauri-test",
      commit: git(["rev-parse", "HEAD"]),
      dirty: !!git(["status", "--porcelain"]),
      builtAt,
    }),
  },
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "safari15", sourcemap: false },
})
