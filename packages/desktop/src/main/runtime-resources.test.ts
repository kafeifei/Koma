import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { snapshotRuntimeResources } from "./runtime-resources"

const roots: string[] = []

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })))

function fixture() {
  const temp = fs.mkdtempSync(join(tmpdir(), "opencode-resources-test-"))
  roots.push(temp)
  const app = join(temp, "Installed.app")
  fs.mkdirSync(app)
  const source = join(app, "app.asar")
  fs.writeFileSync(source, "original archive bytes")
  fs.mkdirSync(`${source}.unpacked`)
  fs.writeFileSync(join(`${source}.unpacked`, "native.node"), "original native bytes")
  return { temp, app, source }
}

test("keeps archive and unpacked files stable across an installed bundle replacement", () => {
  const input = fixture()
  const snapshot = snapshotRuntimeResources(input.source, input.temp, fs)
  fs.renameSync(input.app, join(input.temp, "Backup.app"))
  fs.mkdirSync(input.app)
  fs.writeFileSync(input.source, "replacement archive")
  expect(fs.readFileSync(snapshot.root, "utf8")).toBe("original archive bytes")
  expect(fs.readFileSync(join(`${snapshot.root}.unpacked`, "native.node"), "utf8")).toBe("original native bytes")
  snapshot.dispose()
  expect(fs.existsSync(dirname(snapshot.root))).toBe(false)
  expect(fs.readFileSync(input.source, "utf8")).toBe("replacement archive")
  expect(fs.existsSync(join(input.temp, "Backup.app"))).toBe(true)
})

test("disposing one instance preserves the other instance and installed application", () => {
  const input = fixture()
  const first = snapshotRuntimeResources(input.source, input.temp, fs)
  const second = snapshotRuntimeResources(input.source, input.temp, fs)
  first.dispose()
  first.dispose()
  expect(fs.readFileSync(second.root, "utf8")).toBe("original archive bytes")
  expect(fs.readFileSync(input.source, "utf8")).toBe("original archive bytes")
  second.dispose()
})

test("supports an archive without unpacked files and cleans an incomplete snapshot", () => {
  const input = fixture()
  fs.rmSync(`${input.source}.unpacked`, { recursive: true })
  const snapshot = snapshotRuntimeResources(input.source, input.temp, fs)
  expect(fs.existsSync(`${snapshot.root}.unpacked`)).toBe(false)
  snapshot.dispose()
  expect(() => snapshotRuntimeResources(join(input.temp, "missing.asar"), input.temp, fs)).toThrow()
  expect(fs.readdirSync(input.temp)).toEqual(["Installed.app"])
})
