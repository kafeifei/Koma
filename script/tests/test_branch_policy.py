import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sync", Path(__file__).parents[1] / "sync-upstream.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class BranchPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = self.tmp.name
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        self.git("commit", "--allow-empty", "-m", "base")
        self.git("branch", "dev")

    def git(self, *args):
        return sync.git(self.cwd, *args)

    def test_fast_forward_validation_preserves_main_and_dev(self):
        main = self.git("rev-parse", "main")
        self.git("switch", "-c", "upstream-test")
        self.git("commit", "--allow-empty", "-m", "upstream")
        target = self.git("rev-parse", "HEAD")
        self.assertEqual(sync.validate_lane(self.cwd, target), main)
        self.assertEqual(self.git("rev-parse", "main"), main)
        self.assertEqual(self.git("rev-parse", "dev"), main)

    def test_refuses_custom_dev_history(self):
        base = self.git("rev-parse", "main")
        self.git("switch", "dev")
        self.git("commit", "--allow-empty", "-m", "custom product change")
        old = self.git("rev-parse", "dev")
        self.git("switch", "main")
        with self.assertRaisesRegex(RuntimeError, "diverges"):
            sync.validate_lane(self.cwd, base)
        self.assertEqual(self.git("rev-parse", "dev"), old)

    def test_refuses_dev_in_another_worktree(self):
        self.git("worktree", "add", str(Path(self.cwd) / "other"), "dev")
        with self.assertRaisesRegex(RuntimeError, "checked out"):
            sync.validate_lane(self.cwd, self.git("rev-parse", "main"))

    def test_push_is_blocked_when_upstream_actions_can_run(self):
        def command(cwd, *args):
            if args[:3] == ("remote", "get-url", "origin"):
                return "https://github.com/kafeifei/Koma.git"
            if args[:3] == ("remote", "get-url", "upstream"):
                return "https://github.com/anomalyco/opencode.git"
            if args[0] == "ls-remote":
                return "old\trefs/heads/dev"
            if args[0] == "rev-parse":
                return "new"
            return ""
        with patch.object(sync, "git", side_effect=command) as run, patch.object(sync, "validate_lane", return_value="old"), patch.object(sync.subprocess, "check_output", return_value='{"enabled": true}'):
            with self.assertRaisesRegex(RuntimeError, "Actions must remain disabled"):
                sync.sync(self.cwd, push=True)
            self.assertFalse(any(call.args[1] in ("push", "update-ref") for call in run.call_args_list))


if __name__ == "__main__":
    unittest.main()
