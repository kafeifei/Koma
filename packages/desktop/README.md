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

Settings → Remote uses GitHub device authorization (`read:user` and `read:org`) and Microsoft Dev Tunnels.
The tunnel service requires `read:org` even for owner-only tunnels. Accounts authorized by earlier builds
with only `read:user` must sign out and sign in again to grant it. Signing in only discovers
devices. “Allow remote access” explicitly hosts this computer's existing backend through a separate,
owner-only tunnel. Disabling it closes the host gateway and its active streams. Signing out also closes
this client's connections to other computers; backend sessions continue to belong to their original server.

The macOS Lab packaging step loads the tunnel management, host and client libraries from the candidate archive with its bundled Electron runtime. Missing runtime dependencies fail packaging before signing or installation. The SSH peer dependencies are explicit production dependencies because the Bun package collector does not include peer dependencies.

Credentials are encrypted with Electron `safeStorage`. The feature refuses an unavailable or plaintext
system credential backend. The public OAuth application identity follows Sandy/Code OSS; GitHub may
show Visual Studio Code during consent. See [the shared module notice](../remote/NOTICE) for provenance.
No existing Sandy login data is imported.
Desktop GitHub requests use Electron's Chromium network stack, including device-code exchange,
account lookup and credential refresh; the standalone website keeps its server-side transport.

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

| Directory                        | Contents                                                          |
| -------------------------------- | ----------------------------------------------------------------- |
| `desktop/`                       | Electron profile, web storage, preferences and session data       |
| `data/`                          | SQLite databases, authentication, tool output and `snapshots/`    |
| `config/`                        | OpenCode configuration and global extensions                      |
| `cache/`                         | Rebuildable caches and downloaded tools in `bin/`                 |
| `state/`                         | Backend state and locks                                           |
| `logs/backend/`, `logs/desktop/` | Backend and desktop logs                                          |
| `worktrees/`                     | Managed Git worktrees, grouped by project                         |
| `repos/`                         | Managed repository copies                                         |
| `engines/codex/`                 | Native Codex runtime home, authentication and history             |
| `bin/opencode-lab`               | This fork's terminal CLI                                          |
| `bin/.lab-backend/`              | Backend ownership, startup locks and `service.log`                 |
| `storage.json`                   | Migration state, database choice and existing worktree identities |

Temporary runtime resources and IPC remain in the system temporary directory.
User repositories and their project-local `.opencode` directories remain in place.
Existing auxiliary files under the former desktop profile are preserved in
`desktop/`; migration does not clean caches, old builds or user files.

Run this fork's shared-home CLI from the repository root with:

```bash
bun run dev:lab debug paths
```

The Lab packaging chain builds the fork's native terminal binary into
`resources/opencode-lab` in addition to the separate pinned V2 service binary.
To build and install just the terminal CLI from `packages/desktop`:

```bash
bun run build:lab-cli
bun run install:lab-cli
opencode-lab debug paths
```

Installation stages a versioned executable under `~/.opencode/bin/.opencode-lab/`,
atomically switches `~/.opencode/bin/opencode-lab`, and creates
`~/.local/bin/opencode-lab`. Put `~/.local/bin` on your shell's `PATH` if needed,
or invoke the full path. The official `opencode` command is preserved. A
conflicting `opencode-lab` entry is reported without replacing it. Previous
managed versions remain available to processes that are already using them. An explicit
`OPENCODE_HOME` installs only under that home, without changing shell entries.
The installer also accepts the binary path from a verified Lab app bundle as
its first argument, so local delivery can install the exact packaged executable.

CLI binaries built with `OPENCODE_CHANNEL=lab` use the same launcher. Lab clients
discover one authenticated loopback backend per profile, starting it when needed.
Desktop publishes its bundled binary at an immutable version path before starting
`opencode-lab backend serve`; closing Desktop, a Web page or a CLI does not stop it.
The existing HTTP server and Session engine remain the execution owners. Lab does
not use the pinned V2 sidecar switch to start a second backend. Other channels
retain their existing sidecar selection and upstream CLI defaults.

Use `opencode-lab backend status` to inspect the actual PID, version and protocol;
`opencode-lab backend stop` explicitly stops it. Installing another compatible
binary does not replace a running backend. Neither client shutdown nor packaging
automatically stops or upgrades that backend.

The Lab CLI supports the full terminal UI, `run`, `session list/delete`, `export`,
`models`, `debug paths/config`, and explicit `permission list/reply`. `run --no-wait`
prints the admitted session ID and exits while execution continues on the backend.
Permission requests remain pending until the user answers in a client; the CLI
does not automatically allow or reject them. Commands without an HTTP adapter
(including raw database operations, import, mini mode and upstream maintenance
commands) fail explicitly instead of opening a local execution runtime. Use the
existing Lab UI for provider and server configuration. The separate official
`opencode` command retains its original command set and data.

`opencode-lab uninstall --dry-run` previews removal; `uninstall` removes only the
managed terminal links. Shared sessions, auth, configuration, worktrees and
published binaries remain intact. CLI and HTTP self-upgrades cannot invoke the
official installer for a Lab profile; update using a verified Lab candidate.

The launcher and desktop accept an absolute `OPENCODE_HOME` for isolated instances.
Both configure the same backend paths and disable project configuration. `--help`,
`--version` and `debug paths` do not initialize or migrate a profile. Terminal UI
configuration is loaded without rewriting the backend's legacy configuration.

On macOS, the updated desktop migrates the former
`~/Library/Application Support/OpenCode Lab` profile on first launch. It obtains
the legacy Electron single-instance lock before moving anything, so the old app
must have exited. A registered V2 background service must also have stopped;
a live process or an unreadable service registration blocks migration. The CLI
refuses to perform that migration. Renames keep SQLite
files, WAL sidecars and directory inodes together; a durable manifest makes an
interrupted migration resumable. Independent destination data or a different
filesystem blocks migration instead of overwriting or partially copying it.

Before activating the shared backend, existing v1 profiles are checked for open
database handles (`lsof` is required for this compatibility check). Active older
processes are preserved and startup is refused. The owner then atomically updates
the manifest to v2 with `backendProtocol: 1`, retaining the entire migration record
and all data files. Older Lab builds reject that format; current standalone core
database entrypoints require the recorded backend owner. Incompatible protocols,
invalid ownership records and live but unresponsive owners are never silently
replaced. Do not downgrade the manifest to make an older application open it.

Compatibility symlinks preserve old file paths. Existing managed worktrees also
retain their logical directory identities in the backend so task ownership,
permissions and draft persistence continue to use their original keys. Newly
created worktrees use the new physical directory. Startup also adds retained
archived worktrees that an earlier migration omitted, using their persisted
owners; this does not recreate directories or restore tasks automatically.
Compatible duplicate project-directory records converge when that project is
next accessed. Conflicting non-empty ownership metadata is preserved and logged.
Snapshot repositories from both before and after migration remain readable. Native Codex ownership retains
its previous scope. Do not remove these links or edit `storage.json` by hand.

For an explicit isolated home, only its sibling `<OPENCODE_HOME>.legacy` is a
migration source; it never adopts the installed Lab profile. The first desktop
start after a CLI-created fresh home uses the same data. The official OpenCode
profile and XDG directories are not migrated automatically.
