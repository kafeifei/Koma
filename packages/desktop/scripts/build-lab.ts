import { fileURLToPath } from "node:url"
import { withLabBuildSequence } from "./lab-build-sequence"

export async function buildLab(cwd: string, packaged: boolean) {
  const git = Bun.spawn(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    stdout: "pipe",
    stderr: "inherit",
  })
  const directory = (await new Response(git.stdout).text()).trim()
  if ((await git.exited) !== 0 || !directory)
    throw new Error("Cannot resolve shared Git directory for the Lab build sequence")

  return withLabBuildSequence(directory, async (sequence) => {
    const env = { ...process.env, OPENCODE_CHANNEL: "lab", OPENCODE_LAB_BUILD_SEQUENCE: String(sequence) }
    const commands = packaged
      ? [["prebuild"], ["electron-vite", "build"], ["package:lab"]]
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
      if (code !== 0) throw new Error(`Lab ${command.join(" ")} failed (${code})`)
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
  await buildLab(fileURLToPath(new URL("..", import.meta.url)), process.argv.includes("--package"))
}
