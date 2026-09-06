# Input Retention Without Draft Tasks

## Status

- Product direction approved: remove independently managed draft tasks, retain unsent input per composer.
- Worktree: `/Users/kafeifei/Codes/sayMiao/opencode-app-test-coding`.
- Branch: `input-retention` (renamed from `opencode/isolated-coding` to follow repository naming).
- Base: local `dev` at `39e8da05ff`, including its committed permission-mode changes. No uncommitted changes were copied from the main checkout.
- Implementation and the three review follow-up fixes are complete and focused checks passed. Last-selected permissions survive input lifecycles, legacy indexes wait for confirmed deletion, and explicit prefill is retained after hydration. Nothing staged, committed, merged, pushed, installed, or applied to real user data.
- Legacy-data decision approved: remove legacy draft records and their saved contents on adoption; do not provide a recovery UI. Implement the rule, but do not manually touch the running Lab's data.

## Goal and Boundaries

- Remove the workbench sidebar draft section.
- Repeated New Task actions reuse one unsent composer per existing server scope and normalized directory. Different worktrees remain independent.
- Existing conversations retain their current session-scoped input persistence.
- Switching or closing a new-task page must not discard its unsent text, attachments, context, or last explicitly selected permission mode. First submission does not reset that input's permission choice.
- First submission creates a real session through the existing API. Do not clear another composer or overwrite edits made while an asynchronous submission is pending.
- Remove legacy UUID draft metadata and corresponding prompt documents through existing storage cleanup. This explicit user-approved exception must not delete formal-session input or new per-directory input.
- Reuse existing prompt persistence and attachment storage. Do not add a Task database, server API, permission policy, execution loop, or general retry subsystem.
- Do not change theme/layout beyond removing draft management. No legacy recovery affordance is required or provided.
- Do not access actual user draft storage, restart applications/services, install Lab, push, or commit without the applicable authorization.

## Evidence

- `context/tabs.tsx`: `newDraft` creates a UUID and appends a persisted tab; closing/promoting currently removes the draft document.
- `context/prompt-state.ts` and `context/prompt.tsx`: existing persistence supports draft, directory, and session input scopes, including attachment blobs.
- `app.tsx`: the new-session route and provider identities currently require a DraftTab.
- `pages/layout/task-sidebar.tsx`: the local workbench enumerates these tabs as draft tasks.
- `session-composer-controls.ts` currently changes the identity of an existing draft when selecting a project; worktree selection currently changes submission destination without switching input ownership.
- `submit.ts` and `submission-state.ts` need targeted scope capture and conditional clearing when a reusable composer replaces a disposable draft.
- Legacy draft IDs and routes can still load old content, but the workbench hides the tab strip and has no visible legacy recovery entry.

Investigation initially used `c5c8c95063`. The worktree was then fast-forwarded to `39e8da05ff`; implementation must preserve the newly committed permission-mode fields and behavior.

## Minimal Design

1. Keep the existing internal draft route/provider adapter, but use a deterministic per-scope input identity instead of allocating an independent UUID for every New Task action. The internal adapter is not a user-managed task.
2. Implement the local policy at the tab/input ownership boundary. Preserve the underlying storage and formal-session persistence keys. Normal new-task navigation must never overwrite saved input with an empty initializer.
3. Selecting an existing project/worktree opens that scope's saved composer instead of moving the source text into a different scope. Before a newly requested worktree has a real path, its input remains owned by the source scope.
4. Closing the reusable adapter only navigates away; it keeps the singleton metadata (including permissionMode) and saved input. Promotion to a session must not delete another pending version or reset the input's permission choice.
5. Capture source identity and submission target before asynchronous work. Consume only the submitted input, keep navigation changes independent from submission completion, and retain existing failure recovery without introducing silent data loss.
6. Once persisted tabs are hydrated, attempt legacy UUID cleanup once. Await all scoped document/metadata deletion before removing a legacy tab index; catch failures and keep unfinished indexes hidden for the next hydration. Release attachment references through that API, not by scanning/deleting arbitrary blobs. Preserve formal sessions and new deterministic input slots. Do not read real user stores during development.
7. Remove draft entries from hidden task-tab navigation where necessary so they cannot reappear as ordinary managed tasks.
8. Ordinary opens (undefined/empty string) do not mutate input. Explicit nonempty prefill waits for prompt hydration, then appends after existing content with two newlines; existing parts, their offsets, attachments and context are preserved.

## Expected Files

Primary boundaries: `context/tabs.tsx`, `context/tab-migration.ts`, a small input-policy module if reusable/testable, `pages/layout/task-sidebar.tsx`, `components/titlebar.tsx`, `components/titlebar-tab-strip.tsx`, project/worktree composer controllers, `components/prompt-input/submission-state.ts`, and `components/prompt-input/submit.ts`.

No legacy recovery UI is needed. Change `prompt-state.ts` or new-session routing only if required by ownership correctness. Preserve formal session behavior and new permission-mode integration. Update `PROJECT.md` when the product behavior is implemented.

## Verification

- Before session behavior edits, record a production baseline using the existing performance harness and the workbench's visible navigation, not the hidden tab strip.
- Focused tests: repeated new-task actions; same/different directory and server; persistence hydration and reload; close/reopen; text, attachments and context; existing-session isolation; scoped legacy multi-draft cleanup; first-send success, failure and scope changes during asynchronous creation.
- Run App typecheck and relevant browser/unit tests from `packages/app`, never the repository root.
- Use an isolated mock browser fixture for UI verification. Do not connect migration tests to the running Lab profile/backend.
- Provide a runnable preview or screenshots for the agreed UI behavior before broad verification. Do not run unrelated suites.
- Compare the applicable production benchmark after implementation and report actual results and any limitations.

## Rollback and Limits

- Keep persisted storage formats compatible. User-approved legacy deletion is irreversible after the new version runs; rolling back code does not restore deleted old inputs. Development and tests must use isolated synthetic stores.
- No cross-window live editing/merge guarantee is added. No orphaned-document scan is promised when old tab metadata is missing.
- If implementation requires a larger retry/recovery subsystem or irreversible migration, stop and narrow/confirm that scope instead of expanding silently.

## Handoff

- Read root/App/E2E/performance instructions and Playwright guidance. HEAD verified as `39e8da05ff5b194afc6b1380d1e885a783777237`; initial status contained only this plan.
- Before interruption, added a minimal sidebar variant to the existing production session-switch benchmark, with no business code changes at that checkpoint.
- System Bun is `1.4.0`; pinned runtime obtained with `BUN_INSTALL_CACHE_DIR="$WORKTREE/.cache/bun" bunx bun@1.3.14 --version` (`1.3.14`). Here `$WORKTREE` denotes this document's worktree, not the main checkout.
- Dependency command at worktree root: `BUN_INSTALL_CACHE_DIR="$WORKTREE/.cache/bun" HUSKY=0 bunx bun@1.3.14 install --frozen-lockfile --ignore-scripts`. Initial run installed 4685 packages but reported one extraction failure for unrelated `@pagefind/darwin-arm64@1.5.2`; the same command's retry succeeded with 2 packages installed. No cross-worktree dependency links used; lifecycle scripts disabled.
- Historical interruption checkpoint: the tracked worktree diff then contained only the benchmark spec. Untracked additions then were this plan and the worktree-local `.cache/` dependency cache. Avoid `git status --untracked-files=all`, which expands that cache into a very large listing.
- A worktree-local Vite preview process is still present: PID 96012 (parent 96011), `vite preview --host 0.0.0.0 --port 43171 --strictPort`; its esbuild child is PID 96015. No matching Playwright test runner was found during the check. These observations do not prove that the interrupted coding agent is still active. No process was stopped or restarted.
- The last agent checkpoint reports no real Lab/user storage access and no Git mutations. Do not interpret the preview process as a completed benchmark or functional preview of the requested change.
- Original implementation task ID: `ses_f89ee0637ffehZUzz4piUHP3Nr` (`general`). Its interrupted work was resumed in the same task; implementation and the review follow-up are now complete. No second code writer was started.
- Dependency retry of the same pinned frozen-lockfile command succeeded (2 packages installed). No lockfile changes.
- Baseline used existing production preview PID 96012 at `http://127.0.0.1:43171`; no service restarted/stopped. Its inherited `0.0.0.0` binding was not altered. New services, if needed, must bind only `127.0.0.1`.
- Baseline completed with Node Playwright CLI, temporary `.cache/input-retention.playwright.ts` (existing harness, no webServer), `PLAYWRIGHT_PORT=43171 PLAYWRIGHT_SERVER_PORT=43171 OPENCODE_PERFORMANCE=1 OPENCODE_PERFORMANCE_RUN_ID=input-retention-baseline SESSION_TAB_SWITCH_RUNS=1`, test `session-tab-switch-benchmark.spec.ts --grep "workbench sidebar"`. Result: 1 passed; cold first-correct/stable 89.30/93.30 ms, hot 21.30/30.80 ms; zero blank/wrong/unknown/source samples. One trial per mode is a smoke comparison, not a statistical performance claim.
- Implemented: deterministic `input:` identity from existing `server.scope()` and `pathKey()`; hydrate-time UUID-only metadata/document cleanup via `removePersisted(Persist.prompt(...), platform)`; retained directory input memory/documents on close and promotion; sidebar draft section removal; hidden tab shortcuts and close-next selection exclude directory inputs; project/existing-worktree selection opens target input; source SDK, server, directory, draft identity, permission mode, prompt/context captured before asynchronous creation; only matching submitted snapshots are cleared. Formal-session persistence keys and backend permission policy/API are unchanged.
- Fixed fixture/check issues found during verification: removed unreachable draft-tab rendering after session filtering; extended existing submit mocks for prompt-state/tab-state; supplied actual V2 provider/model/default shapes for send E2E; corrected locators to current accessible names and waited for target route before editing. The tab-cycle helper intentionally does nothing when the current input is excluded from the cycle; Cmd/Ctrl+1 still selects a formal session.
- Changed product files: `packages/app/src/context/{input-retention.ts,tabs.tsx,closed-tabs.ts}`, `src/app.tsx`, `src/pages/layout/task-sidebar.tsx`, `src/pages/new-session/new-session-workspace-controller.ts`, `src/pages/session/composer/session-composer-controls.ts`, `src/components/titlebar-tab-strip.tsx`, `src/components/prompt-input/{submit.ts,submission-state.ts}`. `PROJECT.md` now documents the input ownership and legacy-data policy.
- Changed tests: `src/context/tabs.test.ts`, `src/components/prompt-input/submit.test.ts`, `test-browser/{input-retention.test.ts,prompt-submission-state.test.ts}`, `e2e/regression/input-retention.spec.ts`, and the sidebar variant in `e2e/performance/timeline/session-tab-switch-benchmark.spec.ts`.
- Initial implementation package verification, all from `packages/app` with pinned Bun 1.3.14: solid tests (`tabs.test.ts`, workspace controller, persist) **32 passed**; isolated `submit.test.ts` process **10 passed**; browser-condition prompt persistence/submission/scope/attachments plus `input-retention.test.ts` **19 passed**. `bun typecheck` and `bun run typecheck:e2e` passed.
- Production build command: `BUN_INSTALL_CACHE_DIR="$WORKTREE/.cache/bun" VITE_OPENCODE_SERVER_HOST=127.0.0.1 VITE_OPENCODE_SERVER_PORT=43171 bunx bun@1.3.14 run build --logLevel warn`. Passed; existing mixed static/dynamic imports, large chunks, and duplicate WASM sourcemap emission warnings remain. No new preview service was started after resumption.
- Initial implementation E2E command used Node Playwright CLI with `PLAYWRIGHT_PORT=43171 PLAYWRIGHT_SERVER_PORT=43171`, `--config "$WORKTREE/.cache/input-retention-regression.playwright.ts" input-retention.spec.ts task-workspace.spec.ts --grep-invert "toggles performance diagnostics" --max-failures=2`: **15 passed** (7 new input cases, 8 existing workspace cases). The development-only DEV diagnostics-button test failed when initially included against production (button not present) and was explicitly excluded from that production run; it was not changed or claimed as passing.
- Initial implementation performance command was identical to baseline except run ID `input-retention-final`: **1 passed**, cold first-correct/stable **76.00/80.20 ms**, hot **19.30/22.10 ms**, zero blank/wrong/unknown/source samples. Baseline was **89.30/93.30 ms** and **21.30/30.80 ms**. Both are one cold and one hot trial, not a statistical speedup claim. These measurements precede the three review fixes; the user explicitly requested reusing the baseline rather than repeating performance setup in the follow-up.
- Mock screenshots, both visually inspected: `$WORKTREE/.cache/input-retention-regression-results/input-retention-reuses-new-5d60c-res-after-refresh-and-close-chromium/input-retention-desktop.png` (1200x800) and `input-retention-mobile.png` (390x844) in the same directory. They show the actual production UI with synthetic project/session input and no draft section. The bare preview URL is not a standalone mock backend; use the E2E fixtures for interactive tests.
- `.cache/` contains worktree-local dependency cache, temporary test configs and artifacts; it remains untracked and is not part of the product diff. No shared ignore/config changes were made. The original plan under `docs/` remains intact and updated.
- Verification limits: no full regression suite, packaged Desktop, real backend, cross-window editing, or real-user-data migration run. New worktree source/destination capture is covered by a gated unit test and pending-selection UI test, not a live worktree creation. UUID cleanup only follows hydrated tab metadata and delegates storage removal; no orphan scan or general retry/recovery system is added. Legacy deletion is intentionally irreversible once a future installed version runs it; code rollback cannot recover those old documents.
- The three reported review gaps have been addressed as recorded below. This task must not stage/commit/merge/push or install/restart Lab. Existing isolated preview at port 43171 remains untouched; no services started, restarted, or stopped in the review follow-up.

## Review Follow-Up

- Scope: only last-selected permission persistence, confirmed asynchronous legacy deletion, and explicit nonempty prefill. No dependency installation, new service, cache redesign, backend/API/schema/permission-policy changes, or real data cleanup.
- Reproduction before fixes: three delayed/rejected deletion tests failed; corrected-accessible-label E2E reproduced permission loss on close/reopen and discarded explicit prefill for both existing empty and nonempty singleton inputs (three failures). The tests exercise actual promises and SPA entrypoints, not synchronous Map deletion as a delay surrogate.
- Permission fix: `tabs.tsx` keeps singleton tab metadata on close and only performs navigation. The existing permissionMode field remains the sole stored selection; promotion already preserves this metadata. Tests cover explicit Full Access, explicit Default permissions against a Full Access directory default, refresh, close/reopen, first submission, per-directory/formal-session isolation, and no new singleton rows on reuse.
- Cleanup fix: `utils/persist.ts` now returns completion for all existing async removals while keeping synchronous localStorage removal timing. `input-retention.ts` awaits each legacy record's deletions and catches rejection; `tabs.tsx` makes one attempt after hydration and removes only successfully cleaned keys from the current store. Failed legacy indexes also survive server-list pruning and remain excluded from input routes/sidebar/shortcuts. No worker, permanent polling, or orphan scan.
- Prefill fix: `prefillDirectoryInput` waits for persisted prompt readiness, uses the existing set API, and appends nonempty prefill after current content without shifting existing parts. Both `tabs.newDraft(...)` and the existing direct new-session query entry use it. A direct-entry regression caught the captured prompt's missing ready property; the caller now pairs the captured target with its readiness accessor, and the extended tests pass.
- Follow-up changed files: `packages/app/src/context/{tabs.tsx,input-retention.ts}`, `packages/app/src/utils/persist.ts`, `packages/app/src/pages/new-session/new-session-draft-controller.ts`, `packages/app/test-browser/input-retention.test.ts`, `packages/app/e2e/regression/input-retention.spec.ts`, `PROJECT.md`, and this plan.
- Follow-up package checks (pinned Bun 1.3.14, app cwd): `test-browser/input-retention.test.ts` with browser conditions **7 passed**; `tabs.test.ts` plus `persist.test.ts` with solid conditions **28 passed**; `submit.test.ts` in its own process **10 passed**, retaining permission creation validation. App `bun typecheck` and `bun run typecheck:e2e` passed. Commands use the same absolute worktree preload/file paths and pinned runtime cache as the initial implementation.
- Rebuilt the app with the existing production build command, preserving the same warning set. Final follow-up Playwright run used the existing no-webServer temporary regression config and `input-retention.spec.ts --max-failures=2`: **11 passed (8.8s)**, including the extended legacy-route and direct-query prefill tests. No old dist was used to claim fixes passed.
- The initial 61 package tests / 15 E2E results remain prior-round evidence, not new follow-up execution counts. No full regression or new performance run was performed in this follow-up. `.cache/` remains untracked and is not product code; do not clean it or stop its preview without user authorization.
- Main-thread acceptance check: inspected the final permission-metadata lifecycle, awaited legacy deletion, and prefill changes; independently reran the seven browser-condition input-retention tests with pinned Bun 1.3.14 (7 passed, 0 failed). `git diff --check` passed, and the latest regression artifact reports `status: passed` with no failed tests. No additional implementation was delegated during this check. Functional implementation and scoped verification are complete; packaging, live-data validation, and process/cache cleanup have not been performed.

## Local Integration

- The user explicitly requested merging. Feature commit: `fbda952160`. Earlier no-commit/no-merge notes describe the implementation phase and no longer block this authorized local integration; pushing, installation, and process control remain out of scope.
- Integrated local `dev` at `2e25220f7a`. Resolved three overlapping files without dropping either worktree lifecycle readiness/creation guards or captured input ownership. Both branches' submit regression tests remain present.
- The current mainline defaults new worktree creation to enabled. Switching from an existing worktree to the main directory now carries the explicit local choice through the input route, so remount/refresh does not silently switch it back to Create. The browser fixture follows the current worktree options API and checkbox UI.
- Integrated checks: 11 submit tests, 19 tabs/workspace tests, 11 input-retention browser E2Es, App and E2E typechecks, and production build passed. The E2E checks include returning from a worktree to the retained main-directory input and refreshing with the main-directory selection intact. No dependency installation, new service, or performance rerun was needed.
- Only source, tests, and documentation are committed. `.cache/` remains untracked in the task worktree; no Lab data or running process was changed.
