package main

import "strings"

// These values are replaced at build time with -ldflags -X. Defaults keep
// direct `go run` and local builds useful without requiring Git metadata.
var (
	WorkerVersion = "dev"
	BuildCommit   = "unknown"
	BuildDate     = "unknown"
)

type BuildInfo struct {
	Version string
	Commit  string
	Date    string
}

func CurrentBuildInfo() BuildInfo {
	return BuildInfo{
		Version: buildValue(WorkerVersion, "dev"),
		Commit:  buildValue(BuildCommit, "unknown"),
		Date:    buildValue(BuildDate, "unknown"),
	}
}

func buildValue(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}
