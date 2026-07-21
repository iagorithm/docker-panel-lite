package firebase_runtime

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRequestUsesAuthorizationHeaderWithoutTokenInURL(t *testing.T) {
	var receivedURL string
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		receivedURL = request.URL.String()
		authorization = request.Header.Get("Authorization")
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"ok":true}`)
	}))
	defer server.Close()

	client := testClient(server.URL, server.Client())
	var result map[string]bool
	if err := client.Get(context.Background(), "workers/example", &result); err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if strings.Contains(receivedURL, "test-access-token") || strings.Contains(receivedURL, "access_token") {
		t.Fatalf("request URL leaked access token: %s", receivedURL)
	}
	if authorization != "Bearer test-access-token" {
		t.Fatalf("unexpected authorization header: %q", authorization)
	}
	if !result["ok"] {
		t.Fatalf("unexpected response: %#v", result)
	}
}

func TestRequestRetriesTransientStatus(t *testing.T) {
	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if atomic.AddInt32(&attempts, 1) < 3 {
			http.Error(response, "temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"ok":true}`)
	}))
	defer server.Close()

	client := testClient(server.URL, server.Client())
	var result map[string]bool
	if err := client.Get(context.Background(), "workers/example", &result); err != nil {
		t.Fatalf("Get failed after retry: %v", err)
	}
	if atomic.LoadInt32(&attempts) != 3 {
		t.Fatalf("expected 3 attempts, got %d", atomic.LoadInt32(&attempts))
	}
}

func TestRequestErrorDoesNotExposeAccessToken(t *testing.T) {
	client := testClient("http://127.0.0.1:1", &http.Client{Timeout: 50 * time.Millisecond})
	err := client.Patch(context.Background(), "", map[string]string{"status": "online"})
	if err == nil {
		t.Fatal("expected request error")
	}
	if strings.Contains(err.Error(), "test-access-token") || strings.Contains(err.Error(), "access_token") {
		t.Fatalf("request error leaked access token: %v", err)
	}
}

func testClient(databaseURL string, httpClient *http.Client) *Client {
	return &Client{
		databaseURL: databaseURL,
		httpClient:  httpClient,
		accessToken: "test-access-token",
		expiresAt:   time.Now().Add(time.Hour),
	}
}
