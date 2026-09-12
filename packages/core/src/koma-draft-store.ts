import { createHash } from "node:crypto"

type SQLite = {
  exec(sql: string): unknown
  prepare(sql: string): { get(...args: any[]): unknown; run(...args: any[]): unknown }
  close(): void
}

/** Existing drafts.sqlite schema, shared by Node/Electron and Bun/Koma. */
export function createKomaDraftStore(native: SQLite) {
  native.exec(
    "PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS document (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blob (id TEXT PRIMARY KEY, data BLOB NOT NULL);",
  )
  return {
    get(key: string) {
      return (
        (native.prepare("SELECT value FROM document WHERE key = ?").get(key) as { value: string } | undefined)?.value ??
        null
      )
    },
    set(key: string, value: string | null) {
      // Commit before acknowledging so the other host can immediately read it.
      if (value === null) native.prepare("DELETE FROM document WHERE key = ?").run(key)
      else
        native
          .prepare(
            "INSERT INTO document (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(key, value)
    },
    putBlob(data: Uint8Array) {
      const id = createHash("sha256").update(data).digest("hex")
      native.prepare("INSERT OR IGNORE INTO blob (id, data) VALUES (?, ?)").run(id, data)
      return id
    },
    getBlob(id: string) {
      return (
        (native.prepare("SELECT data FROM blob WHERE id = ?").get(id) as { data: Uint8Array } | undefined)?.data ?? null
      )
    },
    // Blob collection cannot run at host startup: another host may have put a
    // blob that its draft document has not referenced yet.
    flush() {},
    close() {
      native.close()
    },
  }
}
