import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, open, realpath } from "node:fs/promises"
import { join } from "node:path"
import { LabBackend } from "@opencode-ai/core/lab-backend"
import { installLabCli } from "./lab-cli"

type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export async function ensureLabBackend(input: { root: string; source: string; logger: Logger }) {
  const connection = await LabBackend.ensure(input.root, async () => {
    if (!existsSync(input.source)) {
      throw new Error(
        `OpenCode Lab backend executable is unavailable: ${input.source}. Build it with "bun run build:lab-cli" from packages/desktop before starting Lab.`,
      )
    }

    // The application snapshot is process-local and removed on exit. Publish the
    // executable first, then spawn its immutable hash path so an app replacement
    // cannot change or remove the backend used by another client.
    const binary = await realpath(await installLabCli({ source: input.source, root: input.root }))
    const directory = join(input.root, "bin", ".lab-backend")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const output = await open(join(directory, "service.log"), "a", 0o600)
    const child = spawn(binary, ["backend", "serve"], {
      cwd: input.root,
      detached: true,
      env: { ...process.env, OPENCODE_HOME: input.root },
      stdio: ["ignore", output.fd, output.fd],
      windowsHide: true,
    })
    void output
      .close()
      .catch((error) => input.logger.error("failed to close Lab backend log handle", { error: error.message }))
    return new Promise<number>((resolve, reject) => {
      let started = false
      child.once("spawn", () => {
        if (!child.pid) {
          reject(new Error("OpenCode Lab backend started without a process ID"))
          return
        }
        started = true
        child.unref()
        input.logger.log("Lab backend process started", { binary, pid: child.pid })
        resolve(child.pid)
      })
      child.once("error", (error) => {
        if (!started) {
          reject(error)
          return
        }
        input.logger.error("Lab backend process error", { error: error.message, pid: child.pid })
      })
    })
  })

  input.logger.log("Lab backend ready", {
    pid: connection.pid,
    protocol: connection.protocol,
    version: connection.version,
    url: connection.url,
  })
  return {
    connection,
    // Desktop is only a client. Closing its windows must not cancel CLI work
    // still running in the shared backend.
    listener: { stop: () => Promise.resolve() },
  }
}
