---
name: koma-maintenance
description: Maintain Koma branch policy, upstream synchronization, and desktop packaging. Use for Koma sync, branch integration, Debug delivery, or releases.
---

Read the repository's `docs/branches.md` before branch maintenance and `docs/release.md` before packaging.

- Koma product development and the default Debug source are on main; feature branches start from main and target main.
- dev is an exact upstream/dev mirror. Never commit product changes there or merge main into it.
- Use `bun run sync:upstream` for a preview and `bun run sync:upstream --push` when upstream synchronization is requested. Integrate dev separately on a codex/sync-upstream-* branch from main, validate, then merge into main.
- Preserve the upstream publishing guards and Actions isolation when resolving upstream conflicts. The old script/release, script/version.ts, script/publish.ts and script/beta.ts do not publish Koma.
- Debug retains the existing Koma Debug name and is installed to /Applications when delivery is requested. Preserve the running app and backend; an installation does not authorize a restart.
- A release requires the clean main commit, its matching remote main and tag, and verified signed artifacts. A Debug request does not authorize a beta release.
