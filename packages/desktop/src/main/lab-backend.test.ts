import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KomaBackend } from "@opencode-ai/core/koma-backend"
import { ensureKomaBackend } from "./koma-backend"

const logger = { log() {}, error() {} }

test("full App shutdown stops its authenticated backend and permits a fresh backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-desktop-backend-"))
  const root = join(directory, "home")
  const children: Bun.Subprocess[] = []
  const start = async () => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../../../core/test/fixture/lab-backend-worker.ts"), "server", root],
      { cwd: directory, stdout: "ignore", stderr: "inherit" },
    )
    children.push(child)
    return child.pid
  }
  try {
    const first = await KomaBackend.ensure(root, start)
    const backend = await ensureKomaBackend({ root, source: join(directory, "missing"), logger })
    expect(backend.connection.pid).toBe(first.pid)
    const stopping = backend.listener.stop()
    expect(backend.listener.stop()).toBe(stopping)
    await stopping
    expect(await children[0]!.exited).toBe(0)
    expect(await KomaBackend.discover(root)).toBeUndefined()
    const second = await KomaBackend.ensure(root, start)
    expect(second.pid).not.toBe(first.pid)
    await KomaBackend.stop(root, second)
    expect(await children[1]!.exited).toBe(0)
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM")
    await Promise.all(children.map((child) => child.exited))
    await rm(directory, { recursive: true, force: true })
  }
})

test("reports a missing bundled executable before starting a backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-desktop-backend-missing-"))
  try {
    await expect(
      ensureKomaBackend({ root: join(directory, "home"), source: join(directory, "missing"), logger }),
    ).rejects.toThrow('Build it with "bun run build:koma-cli"')
    expect(await Bun.file(join(directory, "home/bin/.lab-backend/backend.json")).exists()).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
