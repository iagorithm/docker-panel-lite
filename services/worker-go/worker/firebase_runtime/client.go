package firebase_runtime

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const tokenURL = "https://oauth2.googleapis.com/token"
const databaseScope = "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email"
const maxRequestAttempts = 3

type Client struct {
	databaseURL string
	account     serviceAccount
	httpClient  *http.Client

	mu          sync.Mutex
	accessToken string
	expiresAt   time.Time
}

type serviceAccount struct {
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

func New(databaseURL, serviceAccountJSON string) (*Client, error) {
	databaseURL = strings.TrimRight(strings.TrimSpace(databaseURL), "/")
	if databaseURL == "" {
		return nil, errors.New("firebase database URL is required")
	}
	if strings.TrimSpace(serviceAccountJSON) == "" {
		return nil, errors.New("FIREBASE_SERVICE_ACCOUNT_JSON is required for the Go worker")
	}
	var account serviceAccount
	if err := json.Unmarshal([]byte(serviceAccountJSON), &account); err != nil {
		return nil, fmt.Errorf("parse service account JSON: %w", err)
	}
	if account.ClientEmail == "" || account.PrivateKey == "" {
		return nil, errors.New("service account JSON must include client_email and private_key")
	}
	if account.TokenURI == "" {
		account.TokenURI = tokenURL
	}
	return &Client{
		databaseURL: databaseURL,
		account:     account,
		httpClient:  &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func (c *Client) Get(ctx context.Context, path string, out interface{}) error {
	return c.request(ctx, http.MethodGet, path, nil, out)
}

func (c *Client) GetWithETag(ctx context.Context, path string, out interface{}) (string, error) {
	token, err := c.token(ctx)
	if err != nil {
		return "", err
	}
	request, err := c.authenticatedRequest(ctx, http.MethodGet, path, token, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("X-Firebase-ETag", "true")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return "", requestError(http.MethodGet, path, err)
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("firebase GET %s failed: %s: %s", path, response.Status, strings.TrimSpace(string(responseBody)))
	}
	if out != nil && len(bytes.TrimSpace(responseBody)) > 0 && string(bytes.TrimSpace(responseBody)) != "null" {
		if err := json.Unmarshal(responseBody, out); err != nil {
			return "", err
		}
	}
	return response.Header.Get("ETag"), nil
}

func (c *Client) Put(ctx context.Context, path string, value interface{}) error {
	return c.request(ctx, http.MethodPut, path, value, nil)
}

func (c *Client) PutIfMatch(ctx context.Context, path string, etag string, value interface{}, out interface{}) (bool, error) {
	token, err := c.token(ctx)
	if err != nil {
		return false, err
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return false, err
	}
	request, err := c.authenticatedRequest(ctx, http.MethodPut, path, token, bytes.NewReader(payload))
	if err != nil {
		return false, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("If-Match", etag)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return false, requestError(http.MethodPut, path, err)
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode == http.StatusPreconditionFailed {
		return false, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false, fmt.Errorf("firebase conditional PUT %s failed: %s: %s", path, response.Status, strings.TrimSpace(string(responseBody)))
	}
	if out != nil && len(bytes.TrimSpace(responseBody)) > 0 && string(bytes.TrimSpace(responseBody)) != "null" {
		if err := json.Unmarshal(responseBody, out); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (c *Client) Patch(ctx context.Context, path string, value interface{}) error {
	return c.request(ctx, http.MethodPatch, path, value, nil)
}

func (c *Client) Delete(ctx context.Context, path string) error {
	return c.request(ctx, http.MethodDelete, path, nil, nil)
}

func (c *Client) request(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	token, err := c.token(ctx)
	if err != nil {
		return err
	}
	var payload []byte
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	for attempt := 1; attempt <= maxRequestAttempts; attempt++ {
		var reader io.Reader
		if payload != nil {
			reader = bytes.NewReader(payload)
		}
		request, err := c.authenticatedRequest(ctx, method, path, token, reader)
		if err != nil {
			return err
		}
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			if attempt < maxRequestAttempts && retryableRequestError(ctx, err) {
				if err := waitForRetry(ctx, attempt); err != nil {
					return requestError(method, path, err)
				}
				continue
			}
			return requestError(method, path, err)
		}
		responseBody, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil {
			if attempt < maxRequestAttempts {
				if err := waitForRetry(ctx, attempt); err != nil {
					return requestError(method, path, err)
				}
				continue
			}
			return requestError(method, path, readErr)
		}
		if retryableStatus(response.StatusCode) && attempt < maxRequestAttempts {
			if err := waitForRetry(ctx, attempt); err != nil {
				return requestError(method, path, err)
			}
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return fmt.Errorf("firebase %s %s failed: %s: %s", method, path, response.Status, strings.TrimSpace(string(responseBody)))
		}
		if out != nil && len(bytes.TrimSpace(responseBody)) > 0 && string(bytes.TrimSpace(responseBody)) != "null" {
			return json.Unmarshal(responseBody, out)
		}
		return nil
	}
	return fmt.Errorf("firebase %s %s failed after %d attempts", method, path, maxRequestAttempts)
}

func (c *Client) url(path string) string {
	clean := strings.Trim(path, "/")
	if clean == "" {
		return c.databaseURL + "/.json"
	}
	return c.databaseURL + "/" + clean + ".json"
}

func (c *Client) authenticatedRequest(ctx context.Context, method string, path string, token string, body io.Reader) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, c.url(path), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	return request, nil
}

func retryableRequestError(ctx context.Context, err error) bool {
	return err != nil && ctx.Err() == nil
}

func retryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusInternalServerError || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func waitForRetry(ctx context.Context, attempt int) error {
	delay := time.Duration(attempt*attempt) * 250 * time.Millisecond
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func requestError(method string, path string, err error) error {
	return fmt.Errorf("firebase %s %s request failed: %w", method, path, err)
}

func (c *Client) token(ctx context.Context) (string, error) {
	c.mu.Lock()
	if c.accessToken != "" && time.Now().Before(c.expiresAt.Add(-60*time.Second)) {
		token := c.accessToken
		c.mu.Unlock()
		return token, nil
	}
	c.mu.Unlock()

	jwt, err := c.signedJWT()
	if err != nil {
		return "", err
	}
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
	form.Set("assertion", jwt)

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.account.TokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("oauth token exchange failed: %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var payload struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", err
	}
	if payload.AccessToken == "" {
		return "", errors.New("oauth token response did not include access_token")
	}
	c.mu.Lock()
	c.accessToken = payload.AccessToken
	c.expiresAt = time.Now().Add(time.Duration(payload.ExpiresIn) * time.Second)
	c.mu.Unlock()
	return payload.AccessToken, nil
}

func (c *Client) signedJWT() (string, error) {
	now := time.Now().Unix()
	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	claims := map[string]interface{}{
		"iss":   c.account.ClientEmail,
		"scope": databaseScope,
		"aud":   c.account.TokenURI,
		"iat":   now,
		"exp":   now + 3600,
	}
	headerJSON, _ := json.Marshal(header)
	claimsJSON, _ := json.Marshal(claims)
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	key, err := parsePrivateKey(c.account.PrivateKey)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func parsePrivateKey(raw string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		return nil, errors.New("private key is not PEM encoded")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("private key is not RSA")
	}
	return rsaKey, nil
}
