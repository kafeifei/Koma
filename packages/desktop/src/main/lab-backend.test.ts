import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LabBackend } from "@opencode-ai/core/lab-backend"
import { StorageMigration } from "@opencode-ai/core/storage-migration"
import { ensureLabBackend } from "./lab-backend"

const logger = { log() {}, error() {} }

test("attaches to a healthy Lab backend without requiring a bundled executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-desktop-backend-"))
  const root = join(directory, "home")
  const owner = await (async () => {
    StorageMigration.prepareUnifiedHome({ root, legacyRoot: join(directory, "legacy"), acquireLock: () => true })
    return LabBackend.claim(root)
  })()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== LabBackend.headers(owner).Authorization) {
        return new Response("unauthorized", { status: 401 })
      }
      return Response.json({ healthy: new URL(request.url).pathname === "/global/health" })
    },
  })
  try {
    await owner.ready(server.url.href)
    const backend = await ensureLabBackend({ root, source: join(directory, "missing"), logger })
    expect(backend.connection.pid).toBe(process.pid)
    await backend.listener.stop()
    expect((await LabBackend.discover(root))?.pid).toBe(process.pid)
  } finally {
    await server.stop(true)
    await owner.release()
    await rm(directory, { recursive: true, force: true })
  }
})

test("reports a missing bundled executable before starting a backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-desktop-backend-missing-"))
  try {
    await expect(
      ensureLabBackend({ root: join(directory, "home"), source: join(directory, "missing"), logger }),
    ).rejects.toThrow('Build it with "bun run build:lab-cli"')
    expect(await Bun.file(join(directory, "home/bin/.lab-backend/backend.json")).exists()).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
