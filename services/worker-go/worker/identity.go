package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io/ioutil"
	"os"
	"path/filepath"
	"strings"
)

func ResolveWorkerToken(dataDir, compiledToken string) (string, error) {
	if configured := strings.TrimSpace(compiledToken); configured != "" {
		return configured, nil
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return "", err
	}
	path := filepath.Join(dataDir, "worker-token")
	if data, err := ioutil.ReadFile(path); err == nil {
		if saved := strings.TrimSpace(string(data)); saved != "" {
			return saved, nil
		}
	}
	token, err := randomToken(24)
	if err != nil {
		return "", err
	}
	if err := ioutil.WriteFile(path, []byte(token+"\n"), 0600); err != nil {
		return "", err
	}
	return token, nil
}

func SHA256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func randomToken(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
