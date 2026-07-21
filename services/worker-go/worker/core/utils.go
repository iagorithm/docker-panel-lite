package core

import (
	"path/filepath"
	"regexp"
	"strings"
)

var safeProjectPattern = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func SafeName(value string) (string, error) {
	cleaned := strings.ToLower(strings.Trim(safeProjectPattern.ReplaceAllString(value, "-"), "-_"))
	if cleaned == "" {
		return "", ErrEmptySafeName
	}
	if len(cleaned) > 63 {
		cleaned = cleaned[:63]
	}
	return cleaned, nil
}

var ErrEmptySafeName = &safeNameError{}

type safeNameError struct{}

func (e *safeNameError) Error() string {
	return "repository alias cannot produce an empty project name"
}

func ValidateRelativeFilePath(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" || filepath.IsAbs(text) {
		return false
	}
	cleaned := filepath.Clean(text)
	return cleaned != "." && cleaned != ".." && !strings.HasPrefix(cleaned, ".."+string(filepath.Separator))
}
