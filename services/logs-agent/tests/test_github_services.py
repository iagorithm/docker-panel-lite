import unittest

from src.github_services import GitHubServices


class GitHubServicesBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.backend = GitHubServices("token", "owner/repository", "main", "run-id", False)

    def test_accepts_services_path(self):
        self.assertEqual(self.backend.safe_path("services/worker/worker/main.py"), "services/worker/worker/main.py")

    def test_rejects_path_outside_services(self):
        with self.assertRaisesRegex(ValueError, "services"):
            self.backend.safe_path("apps/web/app/actions.ts")

    def test_rejects_parent_traversal(self):
        with self.assertRaisesRegex(ValueError, "services"):
            self.backend.safe_path("services/worker/../../.env")

    def test_analysis_mode_blocks_writes_before_network(self):
        result = self.backend.write_file("services/worker/worker/main.py", "content", "reason")
        self.assertIn("WRITE BLOCKED", result)

    def test_hotfix_targets_base_branch_without_creating_branch(self):
        backend = GitHubServices("token", "owner/repository", "main", "run-id", True, True)
        self.assertEqual(backend.ensure_branch(), "main")

    def test_hotfix_blocks_a_second_services_file_before_network(self):
        backend = GitHubServices("token", "owner/repository", "main", "run-id", True, True)
        backend.changes.append({"path": "services/worker/worker/main.py", "commit": "abc", "reason": "first"})
        result = backend.write_file("services/worker/worker/config.py", "content", "second")
        self.assertIn("only one", result)

    def test_fix_branch_uses_english_reason_slug(self):
        backend = GitHubServices("token", "owner/repository", "main", "abcdef123456", True)
        calls = []
        backend.request = lambda method, path, **kwargs: calls.append((method, path, kwargs)) or {"object": {"sha": "base"}}
        branch = backend.ensure_branch("Prevent duplicate deployment ports")
        self.assertEqual(branch, "fix/prevent-duplicate-deployment-ports-abcdef")
        self.assertEqual(calls[-1][2]["json"]["ref"], f"refs/heads/{branch}")

    def test_blocks_truncated_replacement(self):
        previous = "\n".join(f"line {number}" for number in range(100))
        with self.assertRaisesRegex(ValueError, "Destructive fix blocked"):
            self.backend.validate_safe_replacement("services/worker/main.py", previous, "print('replacement')\n")

    def test_blocks_invalid_python(self):
        with self.assertRaisesRegex(ValueError, "Invalid Python fix blocked"):
            self.backend.validate_safe_replacement("services/worker/main.py", "value = 1\n", "value = (\n")

    def test_accepts_small_valid_edit(self):
        previous = "def port_open(port):\n    return False\n"
        proposed = "def port_open(port):\n    return port == 3000\n"
        self.backend.validate_safe_replacement("services/worker/main.py", previous, proposed)


if __name__ == "__main__":
    unittest.main()
