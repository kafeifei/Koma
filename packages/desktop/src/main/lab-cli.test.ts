import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installKomaCli } from "./koma-cli"

const name = process.platform === "win32" ? "koma.exe" : "koma"
const identity = (content: string) => join(".koma", createHash("sha256").update(content).digest("hex"), name)

test("Lab CLI installs and upgrades atomically while preserving the official command and prior executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-cli-install-"))
  try {
    const root = join(directory, "home")
    const source = join(directory, "candidate")
    const linkDirectory = join(directory, "shell-bin")
    await mkdir(linkDirectory)
    await writeFile(join(linkDirectory, "opencode"), "official")
    await writeFile(source, "first fork")
    const link = await installKomaCli({ source, root, linkDirectory })
    const target = join(root, "bin", name)
    expect(await readlink(link)).toBe(target)
    expect(await readlink(target)).toBe(identity("first fork"))
    expect((await stat(target)).mode & 0o111).toBe(0o111)
    const previous = await open(target, "r")
    try {
      await writeFile(source, "second fork")
      expect(await installKomaCli({ source, root, linkDirectory })).toBe(link)
      expect(await previous.readFile("utf8")).toBe("first fork")
      expect(await readFile(link, "utf8")).toBe("second fork")
      expect(await readlink(target)).toBe(identity("second fork"))
      expect(await readFile(join(root, "bin", identity("first fork")), "utf8")).toBe("first fork")
    } finally {
      await previous.close()
    }
    const installed = await lstat(join(root, "bin", identity("second fork")))
    expect(await installKomaCli({ source, root, linkDirectory })).toBe(link)
    expect((await lstat(join(root, "bin", identity("second fork")))).ino).toBe(installed.ino)
    await expect(installKomaCli({ source: join(directory, "missing"), root, linkDirectory })).rejects.toThrow()
    expect(await readFile(link, "utf8")).toBe("second fork")
    expect(await readFile(join(linkDirectory, "opencode"), "utf8")).toBe("official")
    expect(await readdir(root)).toEqual(["bin"])
    expect((await readdir(join(root, "bin"))).sort()).toEqual([".koma", name])
    expect((await readdir(join(root, "bin/.koma"))).sort()).toEqual(
      ["first fork", "second fork"].map((content) => createHash("sha256").update(content).digest("hex")).sort(),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Lab CLI refuses a conflicting shell entry before installing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-cli-conflict-"))
  try {
    const source = join(directory, "candidate")
    const root = join(directory, "home")
    const linkDirectory = join(directory, "shell-bin")
    await mkdir(linkDirectory)
    await writeFile(source, "fork")
    await writeFile(join(linkDirectory, name), "user command")
    await expect(installKomaCli({ source, root, linkDirectory })).rejects.toThrow("already exists")
    expect(await readFile(join(linkDirectory, name), "utf8")).toBe("user command")
    expect(await stat(root).catch(() => undefined)).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Lab CLI preserves unknown target files and links instead of adopting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-cli-owned-"))
  try {
    const source = join(directory, "candidate")
    await writeFile(source, "fork")
    for (const type of ["file", "link"]) {
      const root = join(directory, type)
      const target = join(root, "bin", name)
      await mkdir(join(root, "bin"), { recursive: true })
      if (type === "file") await writeFile(target, "user binary")
      else await symlink(source, target)
      await expect(installKomaCli({ source, root })).rejects.toThrow(type === "file" ? "already exists" : "not managed")
      expect(await readFile(target, "utf8")).toBe(type === "file" ? "user binary" : "fork")
      expect(await readdir(join(root, "bin"))).toEqual([name])
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Lab CLI refuses symlinked managed parents without writing through them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-cli-parents-"))
  try {
    const source = join(directory, "candidate")
    await writeFile(source, "fork")
    for (const type of ["root", "bin", "versions", "version"]) {
      const root = join(directory, type)
      const outside = join(directory, type + "-outside")
      await mkdir(outside)
      await writeFile(join(outside, "sentinel"), "keep")
      const parent =
        type === "root"
          ? root
          : type === "bin"
            ? join(root, "bin")
            : type === "versions"
              ? join(root, "bin/.koma")
              : join(root, "bin/.koma", createHash("sha256").update("fork").digest("hex"))
      await mkdir(join(parent, ".."), { recursive: true })
      await symlink(outside, parent, "dir")
      await expect(installKomaCli({ source, root })).rejects.toThrow("not an owned directory")
      expect(await readdir(outside)).toEqual(["sentinel"])
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Lab CLI rejects modified content behind an otherwise managed target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-cli-integrity-"))
  try {
    const source = join(directory, "candidate")
    const root = join(directory, "home")
    await writeFile(source, "first")
    const target = await installKomaCli({ source, root })
    const previous = await readlink(target)
    await chmod(join(root, "bin", previous), 0o755)
    await writeFile(target, "independent replacement")
    await writeFile(source, "second")
    await expect(installKomaCli({ source, root })).rejects.toThrow("does not match")
    expect(await readlink(target)).toBe(previous)
    expect(await readFile(target, "utf8")).toBe("independent replacement")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "shell-link permission failure leaves the installed version unchanged",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-cli-permission-"))
    const linkDirectory = join(directory, "shell-bin")
    try {
      const source = join(directory, "candidate")
      const root = join(directory, "home")
      await writeFile(source, "first")
      const target = await installKomaCli({ source, root })
      const previous = await readlink(target)
      await writeFile(source, "second")
      await mkdir(linkDirectory, { mode: 0o555 })
      await expect(installKomaCli({ source, root, linkDirectory })).rejects.toThrow("EACCES")
      expect(await readlink(target)).toBe(previous)
      expect(await readFile(target, "utf8")).toBe("first")
      expect(await readdir(linkDirectory)).toEqual([])
      expect((await readdir(join(root, "bin"))).sort()).toEqual([".koma", name])
    } finally {
      await chmod(linkDirectory, 0o755).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test("a precommit path collision removes only the newly prepared shell entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-cli-rollback-"))
  try {
    const root = join(directory, "home")
    const source = join(directory, "candidate")
    const linkDirectory = join(directory, "alias-bin")
    await mkdir(join(root, "bin"), { recursive: true })
    await symlink(join(root, "bin"), linkDirectory, "dir")
    await writeFile(source, "fork")
    // The shell directory alias makes preparing the shell entry collide with the final main link.
    await expect(installKomaCli({ source, root, linkDirectory })).rejects.toThrow("changed during installation")
    expect(await lstat(join(root, "bin", name)).catch(() => undefined)).toBeUndefined()
    expect(await readlink(linkDirectory)).toBe(join(root, "bin"))
    expect((await readdir(join(root, "bin"))).sort()).toEqual([".koma"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
