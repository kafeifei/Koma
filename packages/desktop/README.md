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
