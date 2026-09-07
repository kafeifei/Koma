import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  existsSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lock, prepareUnifiedHome, unifiedHomeLockPath } from "../src/storage-migration"

const fixtures: string[] = []
afterEach(() => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "opencode-home-migration-"))
  fixtures.push(base)
  return {
    root: join(base, ".opencode"),
    legacyRoot: join(base, "Application Support/OpenCode Lab"),
    acquireLock: () => true,
  }
}
function file(path: string, content = path) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}
function populated() {
  const options = fixture()
  const contents = [
    "settings/preferences.dat",
    "drafts.sqlite",
    "session/storage",
    "Crashpad/report",
    "logs/main.log",
    "backend/data/opencode/opencode-lab.db",
    "backend/data/opencode/opencode-local.db",
    "backend/data/opencode/auth.json",
    "backend/config/opencode/opencode.json",
    "backend/cache/opencode/models.json",
    "backend/state/opencode/state.json",
    "backend/data/opencode/worktree/project/task/.git",
    "backend/data/opencode/repos/project/HEAD",
    "backend/data/opencode/snapshot/project/HEAD",
    "backend/data/opencode/log/server.log",
    "backend/state/opencode/codex/sessions/thread.jsonl",
    "backend/state/opencode/codex/state_5.sqlite",
    "backend/cache/.bun/install",
    "backend/cache/bun/runtime",
    "backend/cache/oh-my-posh/theme",
    "backend/state/gh/hosts.yml",
    "build-backups/old/app",
    "preview-builds/old/app",
  ]
  contents.forEach((path) => file(join(options.legacyRoot, path), path))
  return { options, contents }
}
function migrate(
  options: ReturnType<typeof fixture>,
  checkpoint?: Parameters<typeof prepareUnifiedHome>[0]["checkpoint"],
) {
  return prepareUnifiedHome({ ...options, checkpoint })
}

describe("unified home migration", () => {
  test("shared initialization lease excludes a second caller without creating user data", async () => {
    const options = fixture()
    const first = await lock(options.root)
    let acquired = false
    const second = lock(options.root).then((lease) => {
      acquired = true
      return lease
    })
    await Bun.sleep(25)
    expect(acquired).toBe(false)
    expect(existsSync(options.root)).toBe(false)
    await first.release()
    await (await second).release()
    expect(acquired).toBe(true)
  })
  test("refused singleton lock leaves all paths untouched", () => {
    const { options, contents } = populated()
    expect(prepareUnifiedHome({ ...options, acquireLock: () => false })).toBeUndefined()
    expect(existsSync(options.root)).toBe(false)
    contents.forEach((path) => expect(readFileSync(join(options.legacyRoot, path), "utf8")).toBe(path))
  })
  test("running legacy background service blocks migration until its registration is stale", async () => {
    const options = fixture()
    const registration = join(options.legacyRoot, "backend/state/opencode/service.json")
    file(join(options.legacyRoot, "backend/data/opencode/opencode-lab.db"), "database")
    const child = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    file(registration, JSON.stringify({ pid: child.pid, url: "http://127.0.0.1:1" }))

    try {
      expect(() => migrate(options)).toThrow("background service is still running")
      expect(existsSync(options.root)).toBe(false)
      expect(readFileSync(join(options.legacyRoot, "backend/data/opencode/opencode-lab.db"), "utf8")).toBe("database")
    } finally {
      child.kill()
      await child.exited
    }

    expect(migrate(options)?.status).toBe("complete")
    expect(readFileSync(join(options.root, "state/service.json"), "utf8")).toBe(
      JSON.stringify({ pid: child.pid, url: "http://127.0.0.1:1" }),
    )
  })
  test("moves directories, preserves old absolute paths, tools and CLI bin; repeats idempotently", () => {
    const { options, contents } = populated()
    file(join(options.root, "bin/opencode"), "cli")
    const result = migrate(options)!
    expect(result.database).toBe("opencode-lab.db")
    expect(result.codexScope).toBe(
      `codex:${createHash("sha256").update(join(options.legacyRoot, "backend/state/opencode/codex")).digest("hex")}`,
    )
    contents.forEach((path) => expect(readFileSync(join(options.legacyRoot, path), "utf8")).toBe(path))
    expect(readlinkSync(options.legacyRoot)).toBe(join(options.root, "desktop"))
    for (const [path, content] of [
      ["data/auth.json", "backend/data/opencode/auth.json"],
      ["worktrees/project/task/.git", "backend/data/opencode/worktree/project/task/.git"],
      ["repos/project/HEAD", "backend/data/opencode/repos/project/HEAD"],
      ["data/snapshots/project/HEAD", "backend/data/opencode/snapshot/project/HEAD"],
      ["logs/backend/server.log", "backend/data/opencode/log/server.log"],
      ["logs/desktop/main.log", "logs/main.log"],
      ["engines/codex/sessions/thread.jsonl", "backend/state/opencode/codex/sessions/thread.jsonl"],
      ["desktop/backend/state/gh/hosts.yml", "backend/state/gh/hosts.yml"],
    ])
      expect(readFileSync(join(options.root, path!), "utf8")).toBe(content!)
    expect(readFileSync(join(options.root, "bin/opencode"), "utf8")).toBe("cli")
    const manifest = JSON.parse(readFileSync(join(options.root, "storage.json"), "utf8"))
    expect(manifest.worktrees).toEqual([
      {
        directory: join(options.legacyRoot, "backend/data/opencode/worktree/project/task"),
        path: join(options.root, "worktrees/project/task"),
      },
    ])
    expect(manifest.status).toBe("complete")
    expect(migrate(options)).toEqual(result)
  })
  test("fresh home initializes safely alongside CLI bin", () => {
    const options = fixture()
    file(join(options.root, "bin/opencode"), "cli")
    expect(migrate(options)?.database).toBe("opencode.db")
    expect(lstatSync(join(options.root, "engines/codex")).isDirectory()).toBe(true)
    expect(migrate(options)?.status).toBe("complete")
    expect(existsSync(options.legacyRoot)).toBe(false)
    expect(unifiedHomeLockPath(options)).toBe(join(options.root, "desktop"))
    for (const name of ["data", "config", "cache", "state"]) {
      expect(readlinkSync(join(options.root, "desktop/backend", name, "opencode"))).toBe(join(options.root, name))
    }
  })
  test("independent destination fails before moving legacy data", () => {
    const options = populated().options
    file(join(options.root, "data/independent.db"), "independent")
    expect(() => migrate(options)).toThrow("independent data")
    expect(lstatSync(options.legacyRoot).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(options.root, "data/independent.db"), "utf8")).toBe("independent")
    expect(existsSync(join(options.root, "storage.json"))).toBe(false)
  })
  test("rejects source parent symlinks and snapshot collisions before moving", () => {
    const options = fixture()
    const external = join(options.root, "..", "external")
    file(join(external, "opencode/auth.json"), "external")
    mkdirSync(join(options.legacyRoot, "backend"), { recursive: true })
    symlinkSync(external, join(options.legacyRoot, "backend/data"))
    expect(() => migrate(options)).toThrow("owned directory")
    expect(existsSync(options.root)).toBe(false)
    const other = populated().options
    file(join(other.legacyRoot, "backend/data/opencode/snapshots/existing"))
    expect(() => migrate(other)).toThrow("snapshot and snapshots")
    expect(existsSync(other.root)).toBe(false)
  })
  test("rejects ambiguous database selection and orphaned WAL", () => {
    const options = fixture()
    file(join(options.legacyRoot, "backend/data/opencode/opencode.db"))
    file(join(options.legacyRoot, "backend/data/opencode/opencode-local.db"))
    expect(() => migrate(options)).toThrow("ambiguous legacy database")
    expect(existsSync(options.root)).toBe(false)
    const other = fixture()
    file(join(other.legacyRoot, "backend/data/opencode/opencode-lab.db-wal"))
    expect(() => migrate(other)).toThrow("sidecars exist without")
  })
  test("resumes at every durable boundary including between rename and alias", () => {
    const boundaries: string[] = []
    migrate(populated().options, (event) => boundaries.push(event.stage))
    boundaries.forEach((_, index) => {
      const { options, contents } = populated()
      let count = 0
      expect(() =>
        migrate(options, () => {
          if (count++ === index) throw new Error("simulated termination")
        }),
      ).toThrow("simulated termination")
      if (index === 1) expect(unifiedHomeLockPath(options)).toBe(join(options.root, "desktop"))
      expect(migrate(options)?.status).toBe("complete")
      contents.forEach((path) => expect(readFileSync(join(options.legacyRoot, path), "utf8")).toBe(path))
    })
  })
  test("resumes flushed initial manifest awaiting publication", () => {
    const options = populated().options
    expect(() =>
      migrate(options, () => {
        throw new Error("stop")
      }),
    ).toThrow("stop")
    renameSync(join(options.root, "storage.json"), join(options.root, "storage.json.tmp"))
    expect(migrate(options)?.status).toBe("complete")
  })
  test("does not overwrite source recreated after interrupted rename", () => {
    const options = populated().options
    expect(() =>
      migrate(options, (event) => {
        if (event.stage === "renamed") throw new Error("stop")
      }),
    ).toThrow("stop")
    file(join(options.legacyRoot, "unrelated"), "keep")
    expect(() => migrate(options)).toThrow("independent source and destination")
    expect(readFileSync(join(options.legacyRoot, "unrelated"), "utf8")).toBe("keep")
  })
  test("broken completed migration does not create an empty data directory", () => {
    const options = populated().options
    migrate(options)
    renameSync(join(options.root, "data"), join(options.root, "saved-data"))
    expect(() => migrate(options)).toThrow("destination changed")
    expect(existsSync(join(options.root, "data"))).toBe(false)
  })
  test("fresh initialization resumes every compatibility-link boundary", () => {
    const boundaries: string[] = []
    migrate(fixture(), (event) => boundaries.push(event.stage))
    boundaries.forEach((_, index) => {
      const options = fixture()
      let count = 0
      expect(() =>
        migrate(options, () => {
          if (count++ === index) throw new Error("stop")
        }),
      ).toThrow("stop")
      expect(migrate(options)?.status).toBe("complete")
      expect(readlinkSync(join(options.root, "desktop/backend/data/opencode"))).toBe(join(options.root, "data"))
    })
  })
  test("invalid transaction metadata cannot redirect filesystem operations", () => {
    const options = populated().options
    expect(() =>
      migrate(options, () => {
        throw new Error("stop")
      }),
    ).toThrow("stop")
    const manifest = JSON.parse(readFileSync(join(options.root, "storage.json"), "utf8"))
    manifest.operations[0].to = join(options.root, "..", "unowned")
    writeFileSync(join(options.root, "storage.json"), JSON.stringify(manifest))
    expect(() => migrate(options)).toThrow("invalid migration operation")
    expect(lstatSync(options.legacyRoot).isDirectory()).toBe(true)
    expect(existsSync(join(options.root, "..", "unowned"))).toBe(false)
  })
  test("real Git worktree remains usable from old and new paths without rewriting .git", () => {
    const options = fixture()
    const repo = join(options.legacyRoot, "backend/data/opencode/repos/project")
    const worktree = join(options.legacyRoot, "backend/data/opencode/worktree/project/task")
    mkdirSync(repo, { recursive: true })
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    git(repo, "init")
    git(repo, "commit", "--allow-empty", "-m", "fixture")
    git(repo, "worktree", "add", "--detach", worktree)
    const original = readFileSync(join(worktree, ".git"), "utf8")
    const head = git(worktree, "rev-parse", "HEAD")
    migrate(options)
    expect(readFileSync(join(options.root, "worktrees/project/task/.git"), "utf8")).toBe(original)
    for (const path of [worktree, join(options.root, "worktrees/project/task")]) {
      expect(git(path, "rev-parse", "HEAD")).toBe(head)
      expect(git(path, "status", "--porcelain")).toBe("")
    }
    expect(git(join(options.root, "repos/project"), "worktree", "list", "--porcelain")).toContain(worktree)
  })
  test("preserves real SQLite, WAL and SHM names, bytes and committed WAL rows", () => {
    const options = fixture()
    const location = join(options.legacyRoot, "backend/data/opencode")
    mkdirSync(location, { recursive: true })
    // A fixture connection stays open to keep committed rows in WAL. No application database is opened.
    const db = new Database(join(location, "opencode-lab.db"))
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('persisted-in-wal')",
    )
    const before = ["opencode-lab.db", "opencode-lab.db-wal", "opencode-lab.db-shm"].map((name) => ({
      name,
      ino: lstatSync(join(location, name)).ino,
      bytes: readFileSync(join(location, name)),
    }))
    try {
      migrate(options)
      before.forEach(({ name, ino, bytes }) => {
        expect(lstatSync(join(options.root, "data", name)).ino).toBe(ino)
        expect(readFileSync(join(options.root, "data", name))).toEqual(bytes)
      })
      const reopened = new Database(join(options.root, "data/opencode-lab.db"), { readonly: true })
      try {
        expect(reopened.query("SELECT value FROM fixture").get()).toEqual({ value: "persisted-in-wal" })
      } finally {
        reopened.close()
      }
      expect(readdirSync(join(options.root, "data"))).not.toContain("opencode.db")
    } finally {
      db.close()
    }
  })
})
