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

## Remote access (Lab experiment)

Settings → Remote uses GitHub device authorization and Microsoft Dev Tunnels. Signing in only discovers
devices. “Allow remote access” explicitly hosts this computer's existing backend through a separate,
owner-only tunnel. Disabling it closes the host gateway and its active streams. Signing out also closes
this client's connections to other computers; backend sessions continue to belong to their original server.

The macOS Lab packaging step loads the tunnel management, host and client libraries from the candidate archive with its bundled Electron runtime. Missing runtime dependencies fail packaging before signing or installation. The SSH peer dependencies are explicit production dependencies because the Bun package collector does not include peer dependencies.

Credentials are encrypted with Electron `safeStorage`. The feature refuses an unavailable or plaintext
system credential backend. The public OAuth application identity follows Sandy/Code OSS; GitHub may
show Visual Studio Code during consent. See [the shared module notice](../remote/NOTICE) for provenance.
No existing Sandy login data is imported.

Set `OPENCODE_REMOTE_WEBSITE` to the deployed HTTPS address when building or launching the app to show the website
entry in Settings. Without it, account, hosting, and desktop connections still work and the website
address remains unconfigured. The website is a separate [Remote Web](../remote-web/README.md) deployment.
Its GitHub session and the Microsoft tunnel browser authorization are separate; the tunnel may ask
the browser to sign in with the same GitHub account before entering the workspace.

Connections from another desktop reuse the existing server selection and session UI through a local
relay gateway. After restarting the client, reconnect from Remote settings; an old saved loopback
server address cannot resume a previous process's relay. Reconnection reuses the saved local port when
available so the server's local drafts and preferences keep the same address; a port collision requires
a new address. Keep the sharing desktop running and awake.

Run focused checks from this package:

```bash
bun test src/main/remote-controller.test.ts src/main/remote-client.test.ts
OPENCODE_ELECTRON_TEST=1 bun test src/main/remote-client.electron.test.ts
bun typecheck
```

The Electron check requires this checkout's downloaded Electron binary and runs it in Node mode, with
no application window or user profile. It validates HTTP, SSE, WebSocket, and refusal of public-network
fallback in the actual desktop runtime. Bun 1.3.14 does not implement all of the Node HTTP/net behavior
used by the direct `web-entry.test.ts` and `remote-host.test.ts` protocol tests; those also run under
Bun 1.4, while the Electron test is the production-runtime check.

These tests verify lifecycle and protocol boundaries using isolated local servers. They do not replace
GitHub consent, a real account's tunnel registration, or a cross-device browser/desktop acceptance run.

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
must have exited. A registered V2 background service must also have stopped;
a live process or an unreadable service registration blocks migration. The CLI
refuses to perform that migration. Renames keep SQLite
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
