import tempfile
import unittest
from pathlib import Path

from src.fix_store import FixStore


class FixStoreTests(unittest.TestCase):
    def test_persists_and_filters_fixes_by_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "fixes.db")
            store = FixStore(path)
            saved = store.save(
                fix_id="fix_run123", workspace_id="alpha", run_id="run123",
                repository="owner/repository", base_branch="main",
                target_branch="fix/prevent-timeout-run123", commit_sha="abc123",
                commit_message="fix(services): prevent timeout", hotfix=False,
                requested_by="user123", requested_by_email="user@example.com",
                report="Timeout was caused by an unbounded request.",
                changes=[{"path": "services/worker/main.py", "commit": "abc123"}],
                log_ids=["log1", "log2"], patches=[{"path": "services/worker/main.py", "previousContent": "old", "content": "new"}],
            )
            reopened = FixStore(path)
            self.assertEqual(saved["commitSha"], "abc123")
            self.assertTrue(saved["reapplicable"])
            self.assertEqual(reopened.get("alpha", "fix_run123")["logIds"], ["log1", "log2"])
            self.assertEqual(len(reopened.list("alpha")), 1)
            self.assertEqual(reopened.list("another"), [])

    def test_save_is_idempotent_per_run(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FixStore(str(Path(directory) / "fixes.db"))
            arguments = dict(
                fix_id="fix_run123", workspace_id="alpha", run_id="run123",
                repository="owner/repository", base_branch="main", target_branch="main",
                commit_sha="abc123", commit_message="fix: first", hotfix=True,
                requested_by="user123", requested_by_email="", report="report",
                changes=[], log_ids=["log1"],
            )
            store.save(**arguments)
            store.save(**{**arguments, "commit_message": "fix: confirmed"})
            self.assertEqual(len(store.list("alpha")), 1)
            self.assertEqual(store.get("alpha", "fix_run123")["commitMessage"], "fix: confirmed")


if __name__ == "__main__":
    unittest.main()
