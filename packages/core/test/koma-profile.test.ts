import { expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  lstatSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KomaProfile } from "../src/koma-profile"

test("new installs use Koma and do not adopt an official OpenCode directory", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "koma-profile-")))
  try {
    mkdirSync(join(home, ".opencode"))
    expect(KomaProfile.resolveHome({}, home)).toBe(join(home, ".koma"))
    expect(() => KomaProfile.resolveHome({ KOMA_HOME: "relative" }, home)).toThrow("absolute")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("legacy data keeps its physical paths and process locks through a Koma alias", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "koma-profile-")))
  try {
    const old = join(home, ".opencode")
    mkdirSync(old)
    writeFileSync(
      join(old, "storage.json"),
      JSON.stringify({ version: 2, backendProtocol: 1, source: null, status: "complete", database: "opencode.db" }),
    )
    expect(KomaProfile.resolveHome({}, home)).toBe(old)
    expect(lstatSync(join(home, ".koma")).isSymbolicLink()).toBe(true)
    expect(KomaProfile.resolveHome({ KOMA_HOME: join(home, ".koma") }, home)).toBe(old)
    expect(KomaProfile.resolveHome({ OPENCODE_HOME: old }, home)).toBe(old)
    expect(KomaProfile.isDefault(old, home)).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("two independent profiles require an explicit choice", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "koma-profile-")))
  try {
    for (const name of [".opencode", ".koma"]) mkdirSync(join(home, name))
    writeFileSync(
      join(home, ".opencode/storage.json"),
      JSON.stringify({ version: 2, backendProtocol: 1, source: null, status: "complete", database: "opencode.db" }),
    )
    expect(() => KomaProfile.resolveHome({}, home)).toThrow("Both Koma")
    expect(KomaProfile.resolveHome({ KOMA_HOME: join(home, ".koma") }, home)).toBe(join(home, ".koma"))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("legacy backend state remains authoritative after the rename", async () => {
  const { KomaBackend } = await import("../src/koma-backend")
  const root = mkdtempSync(join(tmpdir(), "koma-owner-"))
  try {
    expect(KomaBackend.stateDirectory(root)).toBe(join(root, "bin/.koma-backend"))
    mkdirSync(join(root, "bin/.lab-backend"), { recursive: true })
    expect(KomaBackend.stateDirectory(root)).toBe(join(root, "bin/.lab-backend"))
    mkdirSync(join(root, "bin/.koma-backend"))
    expect(() => KomaBackend.stateDirectory(root)).toThrow("Conflicting")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a new explicit home has the same identity before and after creation through an ancestor alias", () => {
  const parent = mkdtempSync(join(tmpdir(), "koma-new-home-"))
  try {
    const requested = join(parent, "nested", "profile")
    const before = KomaProfile.resolveHome({ KOMA_HOME: requested })
    mkdirSync(requested, { recursive: true })
    expect(KomaProfile.resolveHome({ KOMA_HOME: requested })).toBe(before)
    expect(before).toBe(realpathSync(requested))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("release ignores conflicting developer profiles and never creates a compatibility alias", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "koma-release-profile-")))
  const release = { KOMA_DISTRIBUTION: "release" }
  try {
    mkdirSync(join(home, ".opencode"))
    // Even unreadable legacy metadata must not affect release startup.
    writeFileSync(join(home, ".opencode/storage.json"), "old invalid metadata")
    const expected = KomaProfile.releaseHome(release, home)
    expect(KomaProfile.resolveHome(release, home)).toBe(expected)
    expect(existsSync(join(home, ".koma"))).toBe(false)
    symlinkSync(join(home, ".opencode"), join(home, ".koma"))
    expect(KomaProfile.resolveHome(release, home)).toBe(expected)
    mkdirSync(expected, { recursive: true })
    expect(KomaProfile.resolveHome(release, home)).toBe(expected)
    expect(KomaProfile.isDefault(expected, home, release)).toBe(true)
    expect(KomaProfile.isDefault(join(home, ".opencode"), home, release)).toBe(false)
    expect(KomaProfile.resolveHome({ ...release, KOMA_HOME: join(home, "test") }, home)).toBe(join(home, "test"))
    expect(KomaProfile.commandName(release)).toBe("koma")
    expect(KomaProfile.commandName({})).toBe("koma-debug")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
