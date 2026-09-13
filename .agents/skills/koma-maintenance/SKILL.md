---
name: koma-maintenance
description: Maintain Koma branch policy, upstream synchronization, and desktop packaging. Use for Koma sync, branch integration, Debug delivery (发 debug), or releases.
---

Read the repository's `docs/branches.md` before branch maintenance and `docs/release.md` before packaging.

- Koma product development is on main; feature branches start from main and target main.
- Treat “发 debug” / Debug delivery as authorization to validate, commit, and merge the task's changes into local main before building. Complete those steps without asking again whether to commit or merge; preserve unrelated uncommitted work.
- Immediately before building, resolve refs/heads/main again. Build only with HEAD equal to that latest main commit and a clean working tree. A clean isolated checkout of that commit is allowed; feature-branch builds, uncommitted patch overlays, and older candidates do not fulfill Debug delivery.
- dev is an exact upstream/dev mirror. Never commit product changes there or merge main into it.
- Use `bun run sync:upstream` for a preview and `bun run sync:upstream --push` when upstream synchronization is requested. Integrate dev separately on a codex/sync-upstream-* branch from main, validate, then merge into main.
- Preserve the upstream publishing guards and Actions isolation when resolving upstream conflicts. The old script/release, script/version.ts, script/publish.ts and script/beta.ts do not publish Koma.
- Debug retains the existing Koma Debug name and is installed to /Applications when delivery is requested. Preserve the running app and backend; an installation does not authorize a restart.
- Verify and report the installed version, build ID/sequence, and source main commit; report the observed running state separately. Debug delivery does not authorize a push, tag, or formal release.
- A release requires the clean main commit, its matching remote main and tag, and verified signed artifacts. A Debug request does not authorize a beta release.
