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


if __name__ == "__main__":
    unittest.main()
