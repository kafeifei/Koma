import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { isAbsolute, join } from "node:path"

const repository = join(import.meta.dir, "..")
if (process.argv.includes("--help")) {
  console.log(
    "bun run dev:fast\nSource Koma backend + Vite HMR; no packaging or installation.\nKOMA_FAST_HOME: absolute test profile (default: .local/desktop-tests/fast/profile).\nKOMA_FAST_PORT: UI port (default: an available loopback port).\nCtrl+C stops this test instance. Restart the command after backend changes.",
  )
  process.exit(0)
}
const root = process.env.KOMA_FAST_HOME ?? join(repository, ".local/desktop-tests/fast/profile")
if (!isAbsolute(root)) throw new Error("KOMA_FAST_HOME must be an absolute test-profile path")
const children: ReturnType<typeof Bun.spawn>[] = []
const cancellation = new AbortController()
const cancel = () => cancellation.abort()
process.once("SIGINT", cancel)
process.once("SIGTERM", cancel)
const started = performance.now()
const env = {
  ...process.env,
  KOMA_HOME: root,
  OPENCODE_HOME: root,
  KOMA_BACKEND_INSTANCE: "fast",
  KOMA_RELEASE: "0",
  OPENCODE_CHANNEL: "lab",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
}
const spawn = (args: string[], cwd: string, extra = {}) => {
  const child = Bun.spawn(args, {
    cwd,
    env: { ...env, ...extra },
    detached: true,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  children.push(child)
  return child
}
async function pause() {
  cancellation.signal.throwIfAborted()
  await Bun.sleep(100)
}
async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Cannot allocate UI port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
try {
  const port = process.env.KOMA_FAST_PORT ? Number(process.env.KOMA_FAST_PORT) : await availablePort()
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid KOMA_FAST_PORT")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const backend = spawn([process.execPath, "src/koma.ts", "backend", "serve"], join(repository, "packages/opencode"))
  const deadline = Date.now() + 60_000
  let connection: { pid: number; url: string; username: string; password: string } | undefined
  while (!connection) {
    if (backend.exitCode !== null) throw new Error(`Test backend exited (${backend.exitCode})`)
    if (Date.now() >= deadline) throw new Error("Test backend startup timed out")
    const owner = await readFile(join(root, "bin/.koma-instances/fast/backend.json"), "utf8")
      .then(JSON.parse)
      .catch(() => undefined)
    if (owner?.pid === backend.pid && owner.url) connection = owner
    else await pause()
  }
  const url = new URL(connection.url)
  const ui = spawn(
    [process.execPath, "run", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    join(repository, "packages/app"),
    {
      VITE_OPENCODE_SERVER_HOST: url.hostname,
      VITE_OPENCODE_SERVER_PORT: url.port,
    },
  )
  const uiUrl = `http://127.0.0.1:${port}`
  while (true) {
    if (ui.exitCode !== null) throw new Error(`Vite exited (${ui.exitCode})`)
    if (Date.now() >= deadline) throw new Error("Vite startup timed out")
    if (
      await fetch(uiUrl, { signal: AbortSignal.timeout(1000) })
        .then((response) => response.ok)
        .catch(() => false)
    )
      break
    await pause()
  }
  const login = `${uiUrl}/?auth_token=${encodeURIComponent(Buffer.from(`${connection.username}:${connection.password}`).toString("base64"))}`
  // Keep the current connection in the private test profile for local tools.
  await writeFile(
    join(root, "fast-dev.json"),
    JSON.stringify({
      url: login,
      backend: connection.url,
      pid: backend.pid,
      readySeconds: (performance.now() - started) / 1000,
    }),
    { mode: 0o600 },
  )
  console.log(
    `\nKoma fast test ready in ${((performance.now() - started) / 1000).toFixed(2)}s\n${login}\nProfile: ${root}\nUI: Vite HMR. Backend changes: Ctrl+C and rerun.\n`,
  )
  await Promise.race([
    ...children.map(async (child) => {
      throw new Error(`Development process exited (${await child.exited})`)
    }),
    new Promise<void>((resolve) => {
      if (cancellation.signal.aborted) resolve()
      else cancellation.signal.addEventListener("abort", () => resolve(), { once: true })
    }),
  ])
} catch (error) {
  if (!cancellation.signal.aborted) throw error
} finally {
  for (const child of children.toReversed()) {
    if (child.exitCode !== null) continue
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
  }
  await Promise.race([Promise.all(children.map((child) => child.exited)), Bun.sleep(5000)])
  for (const child of children) {
    if (child.exitCode !== null) continue
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
  }
  process.removeListener("SIGINT", cancel)
  process.removeListener("SIGTERM", cancel)
}
