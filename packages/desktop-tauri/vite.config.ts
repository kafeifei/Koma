import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import appPlugin from "@opencode-ai/app/vite"
import pkg from "../desktop/package.json"

const root = fileURLToPath(new URL("../..", import.meta.url))
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const builtAt = new Date().toISOString()

export default defineConfig({
  plugins: [appPlugin],
  publicDir: "../app/public",
  clearScreen: false,
  define: {
    "import.meta.env.OPENCODE_BUILD": JSON.stringify({
      id: builtAt.replace(/[-:]/g, "").replace("T", ".").slice(0, 15),
      version: pkg.version,
      sequence: process.env.OPENCODE_LAB_BUILD_SEQUENCE ? Number(process.env.OPENCODE_LAB_BUILD_SEQUENCE) : undefined,
      channel: "lab",
      release: process.env.KOMA_RELEASE === "1",
      commit: git(["rev-parse", "HEAD"]),
      dirty: !!git(["status", "--porcelain"]),
      builtAt,
    }),
  },
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "safari15", sourcemap: false, rollupOptions: { input: { index: "index.html", web: "web.html" } } },
})
