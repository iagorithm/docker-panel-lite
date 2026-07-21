package firebase_runtime

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRequestUsesAuthorizationHeaderWithoutTokenInURL(t *testing.T) {
	var receivedURL string
	var authorization string
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		receivedURL = request.URL.String()
		authorization = request.Header.Get("Authorization")
		return response(http.StatusOK, `{"ok":true}`), nil
	})}

	client := testClient("https://example.firebaseio.com", httpClient)
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
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if atomic.AddInt32(&attempts, 1) < 3 {
			return response(http.StatusServiceUnavailable, "temporarily unavailable"), nil
		}
		return response(http.StatusOK, `{"ok":true}`), nil
	})}

	client := testClient("https://example.firebaseio.com", httpClient)
	var result map[string]bool
	if err := client.Get(context.Background(), "workers/example", &result); err != nil {
		t.Fatalf("Get failed after retry: %v", err)
	}
	if atomic.LoadInt32(&attempts) != 3 {
		t.Fatalf("expected 3 attempts, got %d", atomic.LoadInt32(&attempts))
	}
}

func TestRequestErrorDoesNotExposeAccessToken(t *testing.T) {
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return nil, errors.New("temporary network failure")
	})}
	client := testClient("https://example.firebaseio.com", httpClient)
	err := client.Patch(context.Background(), "", map[string]string{"status": "online"})
	if err == nil {
		t.Fatal("expected request error")
	}
	if strings.Contains(err.Error(), "test-access-token") || strings.Contains(err.Error(), "access_token") {
		t.Fatalf("request error leaked access token: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func response(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
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
