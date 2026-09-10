import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { resolveDesktopChannel } from "./src/main/channel"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import pkg from "./package.json"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const channel = process.env.OPENCODE_CHANNEL === "latest" ? "prod" : resolveDesktopChannel(process.env.OPENCODE_CHANNEL)

const git = { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" as const, windowsHide: true }
const builtAt = new Date().toISOString()
// Evaluate once for main and renderer, then freeze the identity into this build.
const buildInfo = {
  id: builtAt.replace(/[-:]/g, "").replace("T", ".").slice(0, 15),
  version: pkg.version,
  channel,
  commit: spawnSync("git", ["rev-parse", "--short=10", "HEAD"], git).stdout?.trim() || undefined,
  dirty: !!spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], git).stdout?.trim(),
  builtAt,
}

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig(async ({ command }) => {
  const sequence =
    channel === "lab" && command === "build" ? Number(process.env.OPENCODE_LAB_BUILD_SEQUENCE) : undefined
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) {
    throw new Error("Use bun run build:lab or bun run lab to reserve a Lab build sequence")
  }
  const build = { ...buildInfo, sequence }
  return {
    main: {
      define: {
        "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
        "import.meta.env.OPENCODE_REMOTE_WEBSITE": JSON.stringify(process.env.OPENCODE_REMOTE_WEBSITE ?? ""),
        "import.meta.env.OPENCODE_BUILD": JSON.stringify(build),
      },
      build: {
        rollupOptions: {
          input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
          // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
          // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
          output: {
            banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
          },
        },
        externalizeDeps: { include: [nodePtyPkg], exclude: ["@opencode-ai/remote"] },
      },
      plugins: [
        {
          name: "opencode:node-pty-narrower",
          enforce: "pre",
          resolveId(s) {
            if (s === "@lydell/node-pty") return nodePtyPkg
          },
        },
        {
          name: "opencode:virtual-server-module",
          enforce: "pre",
          resolveId(id) {
            if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
          },
        },
        {
          name: "opencode:copy-server-assets",
          async writeBundle() {
            for (const l of await readdir(OPENCODE_SERVER_DIST)) {
              if (!l.endsWith(".wasm")) continue
              await writeFile(`./out/main/chunks/${l}`, await readFile(`${OPENCODE_SERVER_DIST}/${l}`))
            }
          },
        },
      ],
    },
    preload: {
      build: {
        rollupOptions: {
          input: { index: "src/preload/index.ts" },
          output: {
            format: "cjs",
            entryFileNames: "[name].js",
          },
        },
      },
    },
    renderer: {
      define: {
        "import.meta.env.OPENCODE_BUILD": JSON.stringify(build),
      },
      plugins: [appPlugin, sentry],
      publicDir: "../../../app/public",
      root: "src/renderer",
      build: {
        sourcemap: true,
        rollupOptions: {
          input: {
            main: "src/renderer/index.html",
            web: "src/renderer/web.html",
          },
        },
      },
    },
  }
})
