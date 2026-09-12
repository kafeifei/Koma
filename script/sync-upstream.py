#!/usr/bin/env python3
"""Keep dev an exact upstream mirror; never merge product changes here."""
import argparse
import json
import subprocess
from pathlib import Path


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def validate_lane(cwd, target):
    old = git(cwd, "rev-parse", "refs/heads/dev")
    if "branch refs/heads/dev" in git(cwd, "worktree", "list", "--porcelain").splitlines():
        raise RuntimeError("dev is checked out in a worktree; switch that worktree to a product branch first")
    result = subprocess.run(["git", "merge-base", "--is-ancestor", old, target], cwd=cwd)
    if result.returncode:
        raise RuntimeError("dev diverges from upstream; preserve its history and investigate, never overwrite it")
    return old


def sync(cwd, push=False):
    origin = git(cwd, "remote", "get-url", "origin").removesuffix(".git").lower()
    upstream = git(cwd, "remote", "get-url", "upstream").removesuffix(".git").lower()
    if origin not in ("https://github.com/kafeifei/koma", "git@github.com:kafeifei/koma"):
        raise RuntimeError("origin must be kafeifei/Koma")
    if upstream not in ("https://github.com/anomalyco/opencode", "git@github.com:anomalyco/opencode"):
        raise RuntimeError("upstream must be anomalyco/opencode")
    git(cwd, "fetch", "--no-tags", "upstream", "dev:refs/remotes/upstream/dev")
    target = git(cwd, "rev-parse", "refs/remotes/upstream/dev")
    old = validate_lane(cwd, target)
    remote = git(cwd, "ls-remote", "origin", "refs/heads/dev").split()
    if not remote or remote[0] != old:
        raise RuntimeError("origin/dev differs from local dev; inspect and reconcile before syncing")
    print(f"dev: {old} -> {target}; main is unchanged", flush=True)
    if not push:
        print("Preview only. Use --push to fast-forward remote and local dev.")
        return
    settings = json.loads(subprocess.check_output(
        ["gh", "api", "repos/kafeifei/Koma/actions/permissions"], text=True, cwd=cwd))
    if settings["enabled"]:
        raise RuntimeError("Repository Actions must remain disabled: pure upstream dev contains upstream automation")
    # Normal push deliberately refuses a concurrent divergence or upstream rewrite.
    git(cwd, "push", "origin", f"{target}:refs/heads/dev")
    git(cwd, "update-ref", "refs/heads/dev", target, old)
    print("Synced. Integrate into main separately on a codex/sync-upstream-* branch.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--push", action="store_true", help="fast-forward origin/dev and local dev")
    args = parser.parse_args()
    try:
        sync(Path(__file__).resolve().parent.parent, args.push)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Sync stopped: {error}\n")
