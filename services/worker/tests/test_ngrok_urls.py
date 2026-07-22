import unittest

from worker.core.ngrok import _ngrok_error_message, _public_tunnel_url


class NgrokPublicUrlTests(unittest.TestCase):
    def test_accepts_generated_public_endpoint(self):
        self.assertTrue(_public_tunnel_url("https://example.ngrok-free.app"))

    def test_accepts_requested_custom_domain(self):
        self.assertTrue(_public_tunnel_url("https://preview.example.com", "preview.example.com"))

    def test_rejects_billing_url(self):
        self.assertFalse(_public_tunnel_url("https://dashboard.ngrok.com/billing/choose-a-plan"))

    def test_rejects_error_text_appended_to_url(self):
        self.assertFalse(_public_tunnel_url("https://dashboard.ngrok.com/billing/choose-a-plan\\r\\nERR_NGROK_314"))

    def test_free_plan_error_explains_how_to_use_generated_domain(self):
        message = _ngrok_error_message("ERR_NGROK_314")

        self.assertIn("Free plan", message)
        self.assertIn("Clear the configured Ngrok domain", message)
        self.assertIn("*.ngrok-free.app", message)

    def test_agent_limit_error_explains_sessions_and_resolution(self):
        message = _ngrok_error_message("err_ngrok_108")

        self.assertIn("agent-session limit", message)
        self.assertIn("dashboard.ngrok.com/agents", message)
        self.assertIn("Each worker ngrok process", message)

    def test_invalid_token_error_does_not_return_generic_billing_advice(self):
        message = _ngrok_error_message("ERR_NGROK_107")

        self.assertIn("invalid, reset, revoked", message)
        self.assertNotIn("review the ngrok account and billing configuration", message)

    def test_network_error_explains_worker_connectivity_checks(self):
        message = _ngrok_error_message("ERR_NGROK_8004")

        self.assertIn("outbound internet", message)
        self.assertIn("firewall", message)


if __name__ == "__main__":
    unittest.main()
