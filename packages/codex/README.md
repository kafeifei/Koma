# `@opencode-ai/codex`

This package owns OpenCode Lab's server-side connection to the pinned native
Codex app-server. Its boundaries are:

- `transport` starts one caller-owned `codex app-server` process, performs the
  initialize handshake, brokers NDJSON requests in both directions, and rejects
  pending requests when that connection generation exits.
- `session` exposes narrow thread, turn, and queue operations plus a runtime
  manager that shares one in-flight connection attempt.
- `projection` converts official thread/item responses and native notifications
  into browser-safe snapshots and updates with stable native references.
- `history` reads one exact, bound rollout path when app-server cannot hydrate
  historical items. It validates the injected Codex home and thread identity,
  never scans a home, and never writes or resumes native history.

- `view` projects native items into the existing Session UI message shape. Native
  identity and display order stay separate; unavailable time, usage, cost, and
  diff fields carry explicit availability.
- `host` connects those operations to the existing Session index, durable native
  bindings and input receipts, worktree execution leases, and the shared SSE
  service. It never writes Codex transcript items into OpenCode history tables.

The binary, Codex home, and cwd are injected by the host. The runtime verifies
`codex-cli 0.153.4` before spawning and does not fall back to another engine or
home.

## Verified 0.153.4 limits

The generated protocol contains APIs that this binary does not fully implement.
`CODEX_NATIVE_CAPABILITY_BASELINE` records the probe result used for capability
gating:

- threads created with `historyMode: "paginated"` retain native user, assistant,
  command and file-change IDs across process restart; full history reads and
  paginated turn/item listing work on those threads. The Host requests this mode;
- legacy hydration returns history after its first user message, but omits
  nested Code Mode tools and synthesizes item IDs. Legacy history is not proof
  that an interrupted command has stopped;
- `turn/interrupt` may finish the turn before a nested command exits. The Host
  keeps durable execution occupancy until explicit native completion evidence,
  including across backend restarts, and keeps the Lab queue paused;
- queue APIs require `experimentalApi` during initialize;
- adding to an idle native queue starts a turn immediately, so it cannot serve
  as a paused host-owned delivery queue.

Run tests and type checking from this package directory. `probe:app-server`
creates a fresh ignored `.cache` home/workspace, starts no login or model turn,
and checks initialize, thread start, metadata read, process restart, and resume.

## Session presentation and titles

Native `commandExecution` and `fileChange` retain their tool names and source
items; Session UI renders them with the existing shell and patch cards. Command
output remains available while running and after failure, and native command
actions remain inspectable without guessing a read/search tool from shell text.
Child cards link only to Session IDs already adopted by the Host.

New tasks use the first nonempty prompt line, normalized and limited to 120
Unicode code points, as their initial title without another model turn. Native
thread names can replace the default title, that exact initial summary, or a
title this Host process previously wrote. Title updates preserve all other
Session fields and publish the existing Session update event. An existing
custom title after a Host restart is preserved: title provenance is not stored,
so ongoing title synchronization across restarts or other clients is not
promised. Manual titles different from those known automatic values win.

## Backend configuration

`OPENCODE_ENABLE_CODEX=1` enables the Lab API's Codex engine. Without it, engine
listing returns no native engines and the host starts no Codex process. Both the
legacy desktop backend and standalone V2 server assemble the same host; the
legacy backend supplies its worktree lifecycle gate.

The host resolves `OPENCODE_CODEX_BINARY`, or a `codex` executable on PATH, or
`~/.local/bin/codex`. The selected executable must match `codex-version.txt`.
This is a development binary lookup, not proof that a desktop package bundles
Codex.

The host uses `OPENCODE_CODEX_HOME` or `<backend state>/codex` for native state.
Lab desktop clears an inherited `OPENCODE_CODEX_HOME` override so it remains in
Lab's own backend storage. The transport sets both `CODEX_HOME` and
`CODEX_SQLITE_HOME` for its child. Authentication uses native account APIs; it
does not copy another Codex installation's credentials or history.
An existing native account remains authoritative. When native authentication is
absent, the Desktop host can supply its existing OpenAI provider credentials via
Codex's external-token API. Provider calls and native refresh requests use the
same backend refresh owner; tokens never enter the UI. The standalone V2 server
keeps native login unless its own credential owner explicitly binds this port.

Queue ownership is fixed to Lab's durable user-input queue for this version.
It feeds one queued input only at a confirmed idle boundary. Stop and process
recovery pause unsubmitted inputs. Unknown delivery receipts prevent automatic
resubmission; a native correlation ID is required to confirm acceptance.

Native V1 child tools use the `multi_agent_v1` namespace. In Code Mode they
may be deferred: `ALL_TOOLS` exposes their normalized names even when the
short tool description omits them. Native same-process wait uses `targets`;
its final-status watch is separate from persisted child history after restart.

Native `turn/plan/updated` notifications are exposed as a validated, read-only
live plan. This binary provides no replay source for those updates, so a new
connection reports the plan as unavailable until another native update arrives.
The Host does not enable optional planning or subagent tools in native config.

The current implementation remains subject to the integration acceptance gates
in [the integration plan](../../docs/plans/codex-native-integration.md), including
native authenticated execution, UI interaction, and recovery verification.

## Source licensing

Integration code follows the repository's MIT license. Protocol declarations in
`src/protocol/generated` are generated from OpenAI Codex 0.153.4 and retain their
Apache-2.0 headers. The upstream [license](src/protocol/LICENSE) and
[notices](src/protocol/NOTICE) accompany those declarations. Protocol generation
normalizes the headers and relative import suffixes; it does not change the wire
types.
