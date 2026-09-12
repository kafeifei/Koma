import { spawn } from "node:child_process"
import { mkdir, open } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { KomaBackend } from "@opencode-ai/core/koma-backend"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { KomaProfile } from "@opencode-ai/core/koma-profile"

// Koma's host adapter uses the upstream server/runtime. Instance selection only
// scopes process discovery and shutdown; project/config/history storage is shared.
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
      "koma backend serve [--port N] | status [--connection] | paths | stop\nKOMA_BACKEND_INSTANCE selects an independent backend (default: electron). KOMA_HOME selects shared data.\nkoma uninstall [--dry-run|--yes]\nUpdate Koma using a verified application build. Shared data is always preserved.",
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
    const options = args.slice(args[0] === "serve" ? 1 : 2)
    const port = options.length ? Number(options[1]) : 0
    if (
      (options.length && (options.length !== 2 || options[0] !== "--port" || !/^\d+$/.test(options[1]!))) ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535
    )
      throw new Error("Use koma backend serve [--port 0..65535]")
    const { serve } = await import("./koma/backend")
    return serve(root, port)
  }
  if (
    args[0] === "backend" &&
    !(
      (args.length === 2 && ["stop", "status", "paths"].includes(args[1] ?? "")) ||
      (args.length === 3 && args[1] === "status" && args[2] === "--connection")
    )
  ) {
    throw new Error("Use koma backend serve, status [--connection], paths, or stop")
  }
  if (args[0] === "backend" && args[1] === "paths") {
    console.log(JSON.stringify({ profile: root, state: KomaBackend.stateDirectory(root) }))
    return
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
              ...(args[2] === "--connection"
                ? {
                    username: connection.username,
                    password: connection.password,
                    profile: root,
                  }
                : {}),
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
