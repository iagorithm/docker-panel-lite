package main

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"fmt"
)

func DecryptSecret(value map[string]interface{}, encodedKey string) (string, error) {
	if stringValue(value["algorithm"]) != "aes-256-gcm" || intValue(value["version"]) != 1 {
		return "", fmt.Errorf("unsupported credential encryption format")
	}
	key, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil {
		return "", err
	}
	if len(key) != 32 {
		return "", fmt.Errorf("CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes")
	}
	iv, err := base64.StdEncoding.DecodeString(stringValue(value["iv"]))
	if err != nil {
		return "", err
	}
	ciphertext, err := base64.StdEncoding.DecodeString(stringValue(value["ciphertext"]))
	if err != nil {
		return "", err
	}
	tag, err := base64.StdEncoding.DecodeString(stringValue(value["tag"]))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	payload := append(ciphertext, tag...)
	plain, err := aead.Open(nil, iv, payload, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
