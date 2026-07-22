import unittest

from worker.core.ngrok import _public_tunnel_url


class NgrokPublicUrlTests(unittest.TestCase):
    def test_accepts_generated_public_endpoint(self):
        self.assertTrue(_public_tunnel_url("https://example.ngrok-free.app"))

    def test_accepts_requested_custom_domain(self):
        self.assertTrue(_public_tunnel_url("https://preview.example.com", "preview.example.com"))

    def test_rejects_billing_url(self):
        self.assertFalse(_public_tunnel_url("https://dashboard.ngrok.com/billing/choose-a-plan"))

    def test_rejects_error_text_appended_to_url(self):
        self.assertFalse(_public_tunnel_url("https://dashboard.ngrok.com/billing/choose-a-plan\\r\\nERR_NGROK_314"))


if __name__ == "__main__":
    unittest.main()
