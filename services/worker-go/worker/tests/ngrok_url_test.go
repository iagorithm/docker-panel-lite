package tests

import (
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
