import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, open, realpath } from "node:fs/promises"
import { join } from "node:path"
import { KomaBackend } from "@opencode-ai/core/koma-backend"
import { installKomaCli } from "./koma-cli"

type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export async function ensureKomaBackend(input: { root: string; source: string; logger: Logger }) {
  const connection = await KomaBackend.ensure(input.root, async () => {
    if (!existsSync(input.source)) {
      throw new Error(
        `Koma backend executable is unavailable: ${input.source}. Build it with "bun run build:koma-cli" from packages/desktop before starting Koma.`,
      )
    }

    // The application snapshot is process-local and removed on exit. Publish the
    // executable first, then spawn its immutable hash path so an app replacement
    // cannot change or remove the backend used by another client.
    const binary = await realpath(await installKomaCli({ source: input.source, root: input.root }))
    const directory = KomaBackend.stateDirectory(input.root)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const output = await open(join(directory, "service.log"), "a", 0o600)
    const child = spawn(binary, ["backend", "serve"], {
      cwd: input.root,
      detached: true,
      env: { ...process.env, OPENCODE_HOME: input.root },
      stdio: ["ignore", output.fd, output.fd],
      windowsHide: true,
    })
    // Cover quitting during startup, before a healthy backend can be attached and stopped normally.
    const stopOnExit = () => child.kill("SIGTERM")
    process.once("exit", stopOnExit)
    child.once("exit", () => process.removeListener("exit", stopOnExit))
    void output
      .close()
      .catch((error) => input.logger.error("failed to close Koma backend log handle", { error: error.message }))
    return new Promise<number>((resolve, reject) => {
      let started = false
      child.once("spawn", () => {
        if (!child.pid) {
          reject(new Error("Koma backend started without a process ID"))
          return
        }
        started = true
        child.unref()
        input.logger.log("Koma backend process started", { binary, pid: child.pid })
        resolve(child.pid)
      })
      child.once("error", (error) => {
        if (!started) {
          reject(error)
          return
        }
        input.logger.error("Koma backend process error", { error: error.message, pid: child.pid })
      })
    })
  })

  input.logger.log("Koma backend ready", {
    pid: connection.pid,
    protocol: connection.protocol,
    version: connection.version,
    url: connection.url,
  })
  let stopping: Promise<void> | undefined
  return {
    connection,
    // Window closure does not call stop; full App quit and relaunch do.
    listener: { stop: () => (stopping ??= KomaBackend.stop(input.root, connection)) },
  }
}
