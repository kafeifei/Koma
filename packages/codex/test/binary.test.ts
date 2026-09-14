import { afterEach, expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveCodexBinary } from "../src/binary"
import { CODEX_RUNTIME_ARCHIVE, CODEX_RUNTIME_VERSION } from "../src/runtime-package"
import { CODEX_APP_SERVER_VERSION, connectCodexAppServer } from "../src/transport"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "koma-codex-binary-"))
  roots.push(root)
  const executable = path.join(root, "koma")
  await writeFile(executable, "fixture")
  return { home: root, cache: path.join(root, "cache"), executable, environment: { PATH: "" } }
}

async function binary(root: string, name: string, version: string) {
  const dir = path.join(root, name)
  await mkdir(dir)
  const file = path.join(dir, "codex")
  await writeFile(file, `#!/bin/sh\necho 'codex-cli ${version}'\n`)
  await chmod(file, 0o755)
  return file
}

test("the runtime package matches the generated protocol version", () => {
  expect(CODEX_RUNTIME_VERSION).toBe(CODEX_APP_SERVER_VERSION)
})

test.skipIf(process.platform === "win32")("a newer first PATH entry does not hide a compatible CLI", async () => {
  const input = await fixture()
  const newer = await binary(input.home, "new", "0.154.0")
  const compatible = await binary(input.home, "compatible", CODEX_APP_SERVER_VERSION)
  input.environment.PATH = [path.dirname(newer), path.dirname(compatible)].join(path.delimiter)
  expect(await resolveCodexBinary(input)).toBe(compatible)
})

test.skipIf(process.platform === "win32")(
  "an incompatible explicit override fails without silently using PATH",
  async () => {
    const input = await fixture()
    const configured = await binary(input.home, "new", "0.154.0")
    const compatible = await binary(input.home, "compatible", CODEX_APP_SERVER_VERSION)
    await expect(
      resolveCodexBinary({
        ...input,
        environment: { OPENCODE_CODEX_BINARY: configured, PATH: path.dirname(compatible) },
      }),
    ).rejects.toThrow("Unsupported Codex binary 0.154.0")
  },
)

test("a corrupt bundled archive fails before any system CLI is selected", async () => {
  const input = await fixture()
  await writeFile(path.join(input.home, CODEX_RUNTIME_ARCHIVE), "corrupt")
  await expect(resolveCodexBinary(input)).rejects.toThrow("checksum mismatch")
})

test.skipIf(!process.env.CODEX_RUNTIME_TEST_ARCHIVE)(
  "a clean profile starts bundled Codex with no installed CLI and survives concurrent extraction",
  async () => {
    const input = await fixture()
    await copyFile(process.env.CODEX_RUNTIME_TEST_ARCHIVE!, path.join(input.home, CODEX_RUNTIME_ARCHIVE))
    const link = path.join(input.home, "koma-link")
    await symlink(input.executable, link)
    const newer = await binary(input.home, "system-cli", "0.154.0")
    const [first, second] = await Promise.all([
      resolveCodexBinary({ ...input, executable: link, environment: { PATH: path.dirname(newer) } }),
      resolveCodexBinary(input),
    ])
    expect(first).toBe(second)
    expect((await realpath(first)).startsWith(await realpath(input.home))).toBe(true)
    const codexHome = path.join(input.home, "codex-home")
    await mkdir(codexHome)
    const connection = await connectCodexAppServer({ binaryPath: first, codexHome, cwd: input.home, generation: 1 })
    try {
      expect(connection.version).toBe(CODEX_APP_SERVER_VERSION)
      expect(connection.initialize.userAgent).toContain(CODEX_APP_SERVER_VERSION)
    } finally {
      await connection.client.close()
    }
  },
  120_000,
)
