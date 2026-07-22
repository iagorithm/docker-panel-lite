package tests

import (
	"strings"
	"testing"

	"docker-panel-lite-worker-go/worker/core"
)

func TestAcceptsNgrokPublicEndpoint(t *testing.T) {
	if !core.IsPublicTunnelURL("https://example.ngrok-free.app", "") {
		t.Fatal("expected generated ngrok endpoint to be accepted")
	}
}

func TestAcceptsRequestedCustomDomain(t *testing.T) {
	if !core.IsPublicTunnelURL("https://preview.example.com", "preview.example.com") {
		t.Fatal("expected requested custom domain to be accepted")
	}
}

func TestRejectsNgrokBillingURL(t *testing.T) {
	if core.IsPublicTunnelURL("https://dashboard.ngrok.com/billing/choose-a-plan", "") {
		t.Fatal("expected ngrok billing URL to be rejected")
	}
}

func TestNgrokAgentLimitErrorExplainsSessionsAndResolution(t *testing.T) {
	message := core.NgrokErrorMessage("err_ngrok_108")
	for _, expected := range []string{"agent-session limit", "dashboard.ngrok.com/agents", "Each worker ngrok process"} {
		if !strings.Contains(message, expected) {
			t.Fatalf("expected %q in %q", expected, message)
		}
	}
}

func TestNgrokInvalidTokenErrorIsSpecific(t *testing.T) {
	message := core.NgrokErrorMessage("ERR_NGROK_107")
	if !strings.Contains(message, "invalid, reset, revoked") {
		t.Fatalf("expected invalid-token diagnosis in %q", message)
	}
	if strings.Contains(message, "review the ngrok account and billing configuration") {
		t.Fatalf("unexpected generic billing advice in %q", message)
	}
}

func TestNgrokNetworkErrorExplainsWorkerChecks(t *testing.T) {
	message := core.NgrokErrorMessage("ERR_NGROK_8004")
	if !strings.Contains(message, "outbound internet") || !strings.Contains(message, "firewall") {
		t.Fatalf("expected network diagnosis in %q", message)
	}
}
