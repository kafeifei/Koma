import { spawn } from "node:child_process"
import { mkdir, open } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { KomaBackend } from "@opencode-ai/core/koma-backend"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { KomaProfile } from "@opencode-ai/core/koma-profile"

// Koma is a client of the existing HTTP server. Never import the upstream CLI
// command registry here: several commands open SQLite or maintain the product.
const args = process.argv.slice(2)
const root = KomaProfile.resolveHome()
try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
process.exit()

async function main() {
  if (
    (args.includes("--help") || args.includes("-h")) &&
    ["backend", "serve", "uninstall", "upgrade"].includes(args[0] ?? "")
  ) {
    console.log(
      "koma backend serve|status|stop\nkoma uninstall [--dry-run|--yes]\nUpdate Koma using a verified application build. Shared data is always preserved.",
    )
    return
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(InstallationVersion)
    return
  }
  if (args[0] === "upgrade")
    throw new Error("Update koma using a verified Koma build; the official OpenCode installer cannot update Koma.")
  if (args[0] === "uninstall") {
    const { uninstall } = await import("./koma/maintenance")
    return uninstall(root, args.slice(1))
  }
  if (args[0] === "serve" || (args[0] === "backend" && args[1] === "serve")) {
    if (args.length > (args[0] === "serve" ? 1 : 2))
      throw new Error("The shared Koma backend uses an authenticated loopback port selected automatically")
    const { serve } = await import("./koma/backend")
    return serve(root)
  }
  if (args[0] === "backend" && (args.length !== 2 || !["stop", "status"].includes(args[1] ?? ""))) {
    throw new Error("Use koma backend serve, status, or stop")
  }
  if (args[0] === "backend" && args[1] === "stop") return KomaBackend.stop(root)
  if (args[0] === "backend" && args[1] === "status") {
    const connection = await KomaBackend.discover(root)
    console.log(
      JSON.stringify(
        connection
          ? {
              running: true,
              pid: connection.pid,
              protocol: connection.protocol,
              version: connection.version,
              url: connection.url,
            }
          : { running: false },
        null,
        2,
      ),
    )
    return
  }
  const { run } = await import("./koma/cli")
  const connection = () =>
    KomaBackend.ensure(root, async () => {
      await mkdir(KomaBackend.stateDirectory(root), { recursive: true, mode: 0o700 })
      const log = await open(join(KomaBackend.stateDirectory(root), "service.log"), "a", 0o600)
      try {
        const source = fileURLToPath(import.meta.url)
        const argv = source.includes("/$bunfs/") ? [] : [source]
        const child = spawn(process.execPath, [...argv, "backend", "serve"], {
          cwd: root,
          env: { ...process.env, OPENCODE_HOME: root },
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        })
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve)
          child.once("error", reject)
        })
        child.unref()
        return child.pid
      } finally {
        await log.close()
      }
    })
  await run(args, connection, root)
}
