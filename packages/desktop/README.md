# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## Lab shared storage

OpenCode Lab and this fork's Lab CLI share `~/.opencode`. The app name,
bundle identity, protocol, sessions and authentication remain unchanged.

| Directory | Contents |
| --- | --- |
| `desktop/` | Electron profile, web storage, preferences and session data |
| `data/` | SQLite databases, authentication, tool output and `snapshots/` |
| `config/` | OpenCode configuration and global extensions |
| `cache/` | Rebuildable caches and downloaded tools in `bin/` |
| `state/` | Backend state and locks |
| `logs/backend/`, `logs/desktop/` | Backend and desktop logs |
| `worktrees/` | Managed Git worktrees, grouped by project |
| `repos/` | Managed repository copies |
| `engines/codex/` | Native Codex runtime home, authentication and history |
| `storage.json` | Migration state, database choice and existing worktree identities |

Temporary runtime resources and IPC remain in the system temporary directory.
User repositories and their project-local `.opencode` directories remain in place.
Existing auxiliary files under the former desktop profile are preserved in
`desktop/`; migration does not clean caches, old builds or user files.

Run this fork's shared-home CLI from the repository root with:

```bash
bun run dev:lab debug paths
```

CLI binaries built with `OPENCODE_CHANNEL=lab` use the same launcher. Ordinary
upstream CLI entrypoints retain their XDG defaults unless `OPENCODE_HOME` is set.
The Lab launcher and desktop accept an absolute `OPENCODE_HOME` for isolated
instances. Desktop disables project configuration as before; the CLI retains its
normal project configuration behavior. Neither changes the parent XDG variables.
The optional pinned V2 CLI receives compatibility XDG paths only in its child
environment, with its database selected from the same manifest.

On macOS, the updated desktop migrates the former
`~/Library/Application Support/OpenCode Lab` profile on first launch. It obtains
the legacy Electron single-instance lock before moving anything, so the old app
must have exited. The CLI refuses to perform that migration. Renames keep SQLite
files, WAL sidecars and directory inodes together; a durable manifest makes an
interrupted migration resumable. Independent destination data or a different
filesystem blocks migration instead of overwriting or partially copying it.

Compatibility symlinks preserve old file paths. Existing managed worktrees also
retain their logical directory identities in the backend so task ownership,
permissions and draft persistence continue to use their original keys. Newly
created worktrees use the new physical directory. Native Codex ownership retains
its previous scope. Do not remove these links or edit `storage.json` by hand.

For an explicit isolated home, only its sibling `<OPENCODE_HOME>.legacy` is a
migration source; it never adopts the installed Lab profile. The first desktop
start after a CLI-created fresh home uses the same data. The official OpenCode
profile and XDG directories are not migrated automatically.
