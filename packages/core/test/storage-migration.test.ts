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
import { StorageDirectory } from "../src/storage-directory"
import { lock, prepareUnifiedHome, reconcileWorktrees, unifiedHomeLockPath } from "../src/storage-migration"

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
  test("deleting the migrated home allows a fresh profile with its remaining compatibility alias", () => {
    const options = populated().options
    migrate(options)
    rmSync(options.root, { recursive: true })
    expect(lstatSync(options.legacyRoot).isSymbolicLink()).toBe(true)
    expect(existsSync(options.legacyRoot)).toBe(false)

    // The backend may claim its instance in bin before initializing storage.
    file(join(options.root, "bin/instance"), "owner")
    expect(migrate(options)?.status).toBe("complete")
    expect(JSON.parse(readFileSync(join(options.root, "storage.json"), "utf8")).source).toBeNull()
    expect(readlinkSync(options.legacyRoot)).toBe(join(options.root, "desktop"))
    expect(lstatSync(join(options.root, "desktop")).isDirectory()).toBe(true)
    expect(existsSync(join(options.root, "data/opencode-lab.db"))).toBe(false)
    expect(migrate(options)?.status).toBe("complete")
  })
  test("a remaining home alias does not permit adopting independent data or unrelated symlinks", () => {
    const options = populated().options
    migrate(options)
    rmSync(join(options.root, "storage.json"))
    expect(() => migrate(options)).toThrow("independent data")
    expect(readFileSync(join(options.root, "data/opencode-lab.db"), "utf8")).toBe(
      "backend/data/opencode/opencode-lab.db",
    )

    const other = fixture()
    mkdirSync(join(other.legacyRoot, ".."), { recursive: true })
    symlinkSync(join(other.root, "..", "unrelated"), other.legacyRoot)
    expect(() => migrate(other)).toThrow("legacy home is not an owned directory")
    expect(existsSync(other.root)).toBe(false)
  })
  test("a reset alias retains its identity through an ancestor directory symlink", () => {
    const options = populated().options
    migrate(options)
    rmSync(options.root, { recursive: true })
    rmSync(options.legacyRoot)
    const parentAlias = join(options.root, "..", "home-alias")
    symlinkSync(join(options.root, ".."), parentAlias)
    const target = join(parentAlias, ".opencode", "desktop")
    symlinkSync(target, options.legacyRoot)
    expect(migrate(options)?.status).toBe("complete")
    expect(readlinkSync(options.legacyRoot)).toBe(target)
    expect(migrate(options)?.status).toBe("complete")
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
  test("retained missing and archived owners keep identity without recreating checkouts", () => {
    const options = fixture()
    const source = join(options.legacyRoot, "backend/data/opencode")
    const owners = [
      { name: "archived", phase: "removed", intent: "archive" },
      { name: "missing", phase: "resident" },
      { name: "deleting", phase: "removed", intent: "delete" },
      { name: "delete-preserve", phase: "delete-preserve", intent: "delete" },
    ]
    for (const owner of owners) {
      const directory = join(source, "worktree/project", owner.name)
      file(
        join(source, "storage/worktree_lifecycle", createHash("sha256").update(directory).digest("hex") + ".json"),
        JSON.stringify({ version: 1, directory, ...owner }),
      )
    }
    migrate(options)
    const manifest = JSON.parse(readFileSync(join(options.root, "storage.json"), "utf8"))
    expect(manifest.worktrees.map((item: { directory: string }) => item.directory).sort()).toEqual([
      join(source, "worktree/project/archived"),
      join(source, "worktree/project/missing"),
    ])
    for (const owner of owners) {
      const physical = join(options.root, "worktrees/project", owner.name)
      expect(existsSync(physical)).toBe(false)
      expect(StorageDirectory.resolve(physical, options.root)).toBe(
        owner.intent === "delete" ? physical : join(source, "worktree/project", owner.name),
      )
    }
  })

  test.each([1, 2] as const)(
    "version %i reconciliation retains its contract across metadata publication",
    (version) => {
      const options = populated().options
      migrate(options)
      const metadata = join(options.root, "storage.json")
      if (version === 2) {
        file(metadata, JSON.stringify({ ...JSON.parse(readFileSync(metadata, "utf8")), version, backendProtocol: 1 }))
        expect(migrate(options)?.status).toBe("complete")
      }
      const directory = join(options.legacyRoot, "backend/data/opencode/worktree/project/archived-before-migration")
      file(
        join(
          options.root,
          "data/storage/worktree_lifecycle",
          createHash("sha256").update(directory).digest("hex") + ".json",
        ),
        JSON.stringify({ version: 1, directory, phase: "removed", intent: "archive" }),
      )
      const before = readFileSync(metadata, "utf8")
      expect(JSON.parse(before).worktrees.some((item: { directory: string }) => item.directory === directory)).toBe(
        false,
      )
      reconcileWorktrees(options)
      const after = readFileSync(metadata, "utf8")
      expect(JSON.parse(after).version).toBe(version)
      expect(JSON.parse(after).backendProtocol).toBe(version === 2 ? 1 : undefined)
      expect(JSON.parse(after).status).toBe("complete")
      expect(
        JSON.parse(after).worktrees.filter((item: { directory: string }) => item.directory === directory),
      ).toHaveLength(1)
      expect(
        StorageDirectory.resolve(join(options.root, "worktrees/project/archived-before-migration"), options.root),
      ).toBe(directory)
      reconcileWorktrees(options)
      expect(readFileSync(metadata, "utf8")).toBe(after)
      file(metadata + ".tmp", after)
      file(metadata, before)
      reconcileWorktrees(options)
      expect(existsSync(metadata + ".tmp")).toBe(false)
      expect(readFileSync(metadata, "utf8")).toBe(after)
      expect(existsSync(directory)).toBe(false)
    },
  )

  test("reconciliation rejects staging metadata that changes the backend contract", () => {
    const options = populated().options
    migrate(options)
    const metadata = join(options.root, "storage.json")
    const before = readFileSync(metadata, "utf8")
    file(metadata, JSON.stringify({ ...JSON.parse(before), version: 2, backendProtocol: 1 }))
    const upgraded = readFileSync(metadata, "utf8")
    file(metadata + ".tmp", before)

    expect(() => reconcileWorktrees(options)).toThrow("not a completed worktree identity update")
    expect(readFileSync(metadata, "utf8")).toBe(upgraded)
    expect(readFileSync(metadata + ".tmp", "utf8")).toBe(before)
  })

  test("completed identity reconciliation refuses a staging file that changes storage ownership", () => {
    const options = populated().options
    migrate(options)
    const metadata = join(options.root, "storage.json")
    const before = readFileSync(metadata, "utf8")
    file(metadata + ".tmp", JSON.stringify({ ...JSON.parse(before), database: "opencode-local.db" }))
    expect(() => reconcileWorktrees(options)).toThrow("not a completed worktree identity update")
    expect(readFileSync(metadata, "utf8")).toBe(before)
    expect(existsSync(metadata + ".tmp")).toBe(true)
  })

  test("retained-owner identity ignores out-of-root, malformed, mismatched and newly created paths", () => {
    const options = populated().options
    migrate(options)
    const records = join(options.root, "data/storage/worktree_lifecycle")
    for (const directory of [
      join(options.root, "worktrees/project/fresh"),
      join(options.legacyRoot, "elsewhere/project/external"),
    ]) {
      file(
        join(records, createHash("sha256").update(directory).digest("hex") + ".json"),
        JSON.stringify({ version: 1, directory, phase: "resident" }),
      )
    }
    const old = join(options.legacyRoot, "backend/data/opencode/worktree/project/old")
    file(join(records, createHash("sha256").update(old).digest("hex") + ".json"), "invalid-json")
    file(join(records, "0".repeat(64) + ".json"), JSON.stringify({ version: 1, directory: old, phase: "removed" }))
    const before = readFileSync(join(options.root, "storage.json"), "utf8")
    reconcileWorktrees(options)
    expect(readFileSync(join(options.root, "storage.json"), "utf8")).toBe(before)
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
  test("reset initialization with a retained home alias resumes every durable boundary", () => {
    const boundaries: string[] = []
    migrate(fixture(), (event) => boundaries.push(event.stage))
    boundaries.forEach((_, index) => {
      const options = populated().options
      migrate(options)
      rmSync(options.root, { recursive: true })
      let count = 0
      expect(() =>
        migrate(options, () => {
          if (count++ === index) throw new Error("stop")
        }),
      ).toThrow("stop")
      expect(migrate(options)?.status).toBe("complete")
      expect(readlinkSync(options.legacyRoot)).toBe(join(options.root, "desktop"))
      expect(JSON.parse(readFileSync(join(options.root, "storage.json"), "utf8")).source).toBeNull()
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

test("completed-home reconciliation retains relocation identities and rejects a conflicting staged update", () => {
  const options = populated().options
  migrate(options)
  const file = join(options.root, "storage.json")
  const manifest = JSON.parse(readFileSync(file, "utf8"))
  const directoryAliases = [
    {
      directory: join(options.root, "../previous/worktrees/project/retained"),
      path: join(options.root, "worktrees/project/retained"),
    },
  ]
  writeFileSync(file, JSON.stringify({ ...manifest, directoryAliases, credentialScope: "a".repeat(64) }))
  expect(migrate(options)?.status).toBe("complete")
  reconcileWorktrees(options)
  expect(JSON.parse(readFileSync(file, "utf8")).directoryAliases).toEqual(directoryAliases)
  expect(JSON.parse(readFileSync(file, "utf8")).credentialScope).toBe("a".repeat(64))
  writeFileSync(file + ".tmp", JSON.stringify({ ...manifest, directoryAliases, credentialScope: "b".repeat(64) }))
  expect(() => migrate(options)).toThrow("manifest staging is not a completed worktree identity update")
  expect(JSON.parse(readFileSync(file, "utf8")).directoryAliases).toEqual(directoryAliases)
})
