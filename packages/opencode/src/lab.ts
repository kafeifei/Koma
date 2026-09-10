import { spawn } from "node:child_process"
import { mkdir, open } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { LabBackend } from "@opencode-ai/core/lab-backend"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

// Lab is a client of the existing HTTP server. Never import the upstream CLI
// command registry here: several commands open SQLite or maintain the product.
const args = process.argv.slice(2)
const root = StoragePaths.resolve(process.env.OPENCODE_HOME ?? join(homedir(), ".opencode")).root
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
      "opencode-lab backend serve|status|stop\nopencode-lab uninstall [--dry-run|--yes]\nUpdate Lab using a verified application build. Shared data is always preserved.",
    )
    return
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(InstallationVersion)
    return
  }
  if (args[0] === "upgrade")
    throw new Error(
      "Update opencode-lab using a verified Lab build; the official OpenCode installer cannot update Lab.",
    )
  if (args[0] === "uninstall") {
    const { uninstall } = await import("./lab/maintenance")
    return uninstall(root, args.slice(1))
  }
  if (args[0] === "serve" || (args[0] === "backend" && args[1] === "serve")) {
    if (args.length > (args[0] === "serve" ? 1 : 2))
      throw new Error("The shared Lab backend uses an authenticated loopback port selected automatically")
    const { serve } = await import("./lab/backend")
    return serve(root)
  }
  if (args[0] === "backend" && (args.length !== 2 || !["stop", "status"].includes(args[1] ?? ""))) {
    throw new Error("Use opencode-lab backend serve, status, or stop")
  }
  if (args[0] === "backend" && args[1] === "stop") return LabBackend.stop(root)
  if (args[0] === "backend" && args[1] === "status") {
    const connection = await LabBackend.discover(root)
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
  const { run } = await import("./lab/cli")
  const connection = () =>
    LabBackend.ensure(root, async () => {
      await mkdir(join(root, "bin", ".lab-backend"), { recursive: true, mode: 0o700 })
      const log = await open(join(root, "bin", ".lab-backend", "service.log"), "a", 0o600)
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
