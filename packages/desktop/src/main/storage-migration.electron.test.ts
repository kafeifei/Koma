import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { StorageMigration } from "@opencode-ai/core/storage-migration"

const fixtures: string[] = []
const children: { kill: () => void; exited: Promise<number> }[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
  fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

// Opt-in because this starts this checkout's real Electron, using temporary profiles and no windows.
describe.skipIf(process.env.OPENCODE_ELECTRON_TEST !== "1")("Electron storage singleton integration", () => {
  test("legacy holder blocks migration; stopped fixture migrates and reopens; fresh profiles bootstrap", async () => {
    const base = mkdtempSync(join(tmpdir(), "opencode-electron-migration-"))
    fixtures.push(base)
    const source = join(base, "fixture.ts")
    writeFileSync(
      source,
      `
      import { app } from 'electron';
      import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
      import { join } from 'node:path';
      import { StorageMigration } from ${JSON.stringify(resolve(import.meta.dir, "../../../core/src/storage-migration.ts"))};
      const input = JSON.parse(process.env.OPENCODE_MIGRATION_FIXTURE);
      const sandbox = join(input.base, 'process-' + process.pid);
      mkdirSync(sandbox, { recursive: true });
      app.setPath('appData', sandbox);
      app.setPath('userData', sandbox);
      app.setPath('sessionData', sandbox);
      app.commandLine.appendSwitch('disable-gpu');
      process.on('SIGTERM', () => app.exit(0));
      setTimeout(() => app.exit(99), 15000).unref();
      function report(value) {
        writeFileSync(input.result + '.tmp', JSON.stringify(value));
        renameSync(input.result + '.tmp', input.result);
      }
      async function main() {
        const paths = { root: input.root, legacyRoot: input.legacyRoot };
        if (input.mode === 'holder') {
          app.setPath('userData', input.legacyRoot);
          const acquired = app.requestSingleInstanceLock();
          report({ acquired, userData: app.getPath('userData') });
          if (!acquired) app.exit(0);
          return;
        }
        const lease = await StorageMigration.lock(input.root);
        try {
          const lockPath = StorageMigration.unifiedHomeLockPath(paths);
          app.setPath('userData', lockPath);
          const result = StorageMigration.prepareUnifiedHome({ ...paths, acquireLock: () => app.requestSingleInstanceLock() });
          if (result) app.setPath('userData', result.desktop);
          report({ acquired: !!result, lockPath, result, userData: app.getPath('userData') });
        } finally { await lease.release(); }
        if (input.mode !== 'migrate-holder') app.exit(0);
      }
      main().catch(error => { report({ error: error.message, stack: error.stack }); app.exit(1); });
    `,
    )
    const build = await Bun.build({ entrypoints: [source], outdir: base, target: "node", external: ["electron"] })
    expect(build.success).toBe(true)
    const executable = resolve(import.meta.dir, "../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    expect(existsSync(executable)).toBe(true)
    async function run(mode: string, root: string, legacyRoot: string) {
      const result = join(base, `result-${children.length}.json`)
      const child = Bun.spawn([executable, join(base, "fixture.js")], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          OPENCODE_MIGRATION_FIXTURE: JSON.stringify({ base, mode, root, legacyRoot, result }),
        },
        stdout: "ignore",
        stderr: "pipe",
      })
      children.push(child)
      for (let attempt = 0; attempt < 500 && !existsSync(result); attempt++) await Bun.sleep(20)
      if (!existsSync(result)) {
        child.kill()
        throw new Error(await new Response(child.stderr).text())
      }
      const output = JSON.parse(readFileSync(result, "utf8"))
      if (output.error) throw new Error(JSON.stringify(output))
      return { child, output }
    }
    const root = join(base, "migration/.opencode")
    const legacyRoot = join(base, "migration/OpenCode Lab")
    mkdirSync(join(legacyRoot, "settings"), { recursive: true })
    writeFileSync(join(legacyRoot, "settings/state.dat"), "preserve")
    const holder = await run("holder", root, legacyRoot)
    expect(holder.output.acquired).toBe(true)
    expect((await run("migrate", root, legacyRoot)).output.acquired).toBe(false)
    expect(existsSync(root)).toBe(false)
    expect(readFileSync(join(legacyRoot, "settings/state.dat"), "utf8")).toBe("preserve")
    holder.child.kill()
    await holder.child.exited
    const migrated = await run("migrate-holder", root, legacyRoot)
    expect(migrated.output.acquired).toBe(true)
    expect((await run("migrate", root, legacyRoot)).output.acquired).toBe(false)
    migrated.child.kill()
    await migrated.child.exited
    expect(lstatSync(legacyRoot).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(root, "desktop/settings/state.dat"), "utf8")).toBe("preserve")
    expect((await run("migrate", root, legacyRoot)).output.acquired).toBe(true)

    const freshRoot = join(base, "fresh/.opencode")
    const freshLegacy = join(base, "fresh/OpenCode Lab")
    expect((await run("migrate", freshRoot, freshLegacy)).output.acquired).toBe(true)
    expect(JSON.parse(readFileSync(join(freshRoot, "storage.json"), "utf8")).source).toBe(freshLegacy)
    expect((await run("migrate", freshRoot, freshLegacy)).output.acquired).toBe(true)

    const cliRoot = join(base, "cli/.opencode")
    const cliLegacy = join(base, "cli/OpenCode Lab")
    StorageMigration.prepareUnifiedHome({ root: cliRoot, legacyRoot: cliLegacy, acquireLock: () => true })
    expect(existsSync(cliLegacy)).toBe(false)
    const desktop = await run("migrate", cliRoot, cliLegacy)
    expect(desktop.output.acquired).toBe(true)
    expect(desktop.output.lockPath).toBe(join(cliRoot, "desktop"))
    expect(existsSync(cliLegacy)).toBe(false)
  }, 30000)
})
