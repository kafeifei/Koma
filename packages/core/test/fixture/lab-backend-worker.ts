import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { KomaBackend } from "../../src/koma-backend"
import { StorageMigration } from "../../src/storage-migration"
import { StoragePaths } from "../../src/storage-paths"

const [mode, root] = process.argv.slice(2)
const base = dirname(root)

async function main() {
  if (mode === "same-pid-writer") {
    const file = join(root, "bin/.koma-backend/backend.json")
    const previous = JSON.parse(await readFile(file, "utf8"))
    // Model a retained ownership record whose PID has since been reused by this unrelated process.
    await writeFile(file, JSON.stringify({ ...previous, pid: process.pid }))
    KomaBackend.assertWriter(root)
    return { pid: process.pid }
  }
  if (mode === "writer") {
    KomaBackend.assertWriter(root)
    return { pid: process.pid }
  }
  if (mode === "database-path") {
    const { Database } = await import("../../src/database/database")
    return { pid: process.pid, path: Database.path() }
  }
  if (mode === "ensure") {
    return KomaBackend.ensure(root, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, "server", root], {
        cwd: base,
        env: process.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      child.unref()
      await appendFile(join(base, "spawned.jsonl"), `${JSON.stringify({ pid: child.pid })}\n`)
      return child.pid
    })
  }
  if (mode === "claim" || mode === "activate") {
    const owner = await KomaBackend.claim(root)
    try {
      if (mode === "activate") await KomaBackend.activate(root)
      return { pid: process.pid }
    } finally {
      await owner.release()
    }
  }
  if (mode === "hold-database") {
    const handle = await open(StoragePaths.database(root), "r")
    const timer = setInterval(() => {}, 1000)
    process.on("SIGTERM", async () => {
      clearInterval(timer)
      await handle.close()
      process.exit(0)
    })
    await writeFile(join(base, "database-held"), String(process.pid))
    return await new Promise<never>(() => {})
  }
  if (mode !== "server") throw new Error(`Unknown fixture mode: ${mode}`)

  const owner = await KomaBackend.claim(root)
  {
    await using lease = await StorageMigration.lock(root)
    StorageMigration.prepareUnifiedHome({ root, legacyRoot: join(base, "legacy"), acquireLock: () => true })
    await KomaBackend.activate(root)
    KomaBackend.assertWriter(root)
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== KomaBackend.headers(owner).Authorization) {
        return new Response("unauthorized", { status: 401 })
      }
      const route = new URL(request.url).pathname
      if (route === "/test/writer") {
        KomaBackend.assertWriter(root)
        return new Response("allowed")
      }
      if (route === "/test/unhealthy") {
        await writeFile(join(base, "unhealthy"), "")
        return new Response("ok")
      }
      if (route === "/test/healthy") {
        await rm(join(base, "unhealthy"), { force: true })
        return new Response("ok")
      }
      if (route !== "/global/health") return new Response("missing", { status: 404 })
      const unhealthy = await readFile(join(base, "unhealthy")).then(
        () => true,
        () => false,
      )
      if (unhealthy) await writeFile(join(base, "health-rejected"), "")
      return Response.json({ healthy: !unhealthy }, { status: unhealthy ? 503 : 200 })
    },
  })
  process.on("SIGTERM", async () => {
    await owner.release()
    await server.stop(true)
    await writeFile(join(base, `${process.pid}.stopped`), "")
    process.exit(0)
  })
  await owner.ready(server.url.href)
  return await new Promise<never>(() => {})
}

try {
  const result = await main()
  console.log(JSON.stringify({ ok: true, ...result }))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  await mkdir(base, { recursive: true })
  await appendFile(join(base, "errors.jsonl"), `${JSON.stringify({ mode, error: message })}\n`)
  console.log(JSON.stringify({ ok: false, error: message }))
}
