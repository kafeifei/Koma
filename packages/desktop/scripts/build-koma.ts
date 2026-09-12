import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { withKomaBuildSequence } from "./koma-build-sequence"
import pkg from "../package.json"

export async function buildKoma(cwd: string, packaged: boolean) {
  const readGit = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
  if (readGit("branch", "--show-current") === "dev")
    throw new Error("dev only mirrors upstream. Build Koma from main or a product feature branch.")
  if (process.env.KOMA_RELEASE === "1") {
    if (readGit("rev-parse", "HEAD") !== readGit("rev-parse", "refs/heads/main") || readGit("status", "--porcelain"))
      throw new Error("Koma release builds require a clean checkout at the main commit.")
  }
  const git = Bun.spawn(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    stdout: "pipe",
    stderr: "inherit",
  })
  const directory = (await new Response(git.stdout).text()).trim()
  if ((await git.exited) !== 0 || !directory)
    throw new Error("Cannot resolve shared Git directory for the Koma build sequence")

  return withKomaBuildSequence(directory, async (sequence) => {
    const env = {
      ...process.env,
      OPENCODE_CHANNEL: "lab",
      OPENCODE_LAB_BUILD_SEQUENCE: String(sequence),
      OPENCODE_VERSION: pkg.version,
    }
    const commands = packaged
      ? [
          ["prebuild"],
          ["electron-vite", "build"],
          [process.env.KOMA_RELEASE === "1" ? "package:release" : "package:debug"],
        ]
      : [["electron-vite", "build"]]
    const cancellation = new AbortController()
    for (const command of commands) {
      const child = Bun.spawn([process.execPath, "run", ...command], {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      const interrupt = () => {
        cancellation.abort()
        stopBuild(child.pid, "SIGINT")
      }
      const terminate = () => {
        cancellation.abort()
        stopBuild(child.pid, "SIGTERM")
      }
      process.once("SIGINT", interrupt)
      process.once("SIGTERM", terminate)
      const code = await child.exited.finally(() => {
        process.removeListener("SIGINT", interrupt)
        process.removeListener("SIGTERM", terminate)
      })
      if (cancellation.signal.aborted) {
        // Stop remaining descendants before releasing the build reservation.
        stopBuild(child.pid, "SIGKILL")
        cancellation.signal.throwIfAborted()
      }
      if (code !== 0) throw new Error(`Koma ${command.join(" ")} failed (${code})`)
    }
    return sequence
  })
}

function stopBuild(pid: number, signal: NodeJS.Signals) {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
  }
}

if (import.meta.main) {
  await buildKoma(fileURLToPath(new URL("..", import.meta.url)), process.argv.includes("--package"))
}
