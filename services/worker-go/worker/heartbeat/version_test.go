package heartbeat

import "testing"

func TestCurrentBuildInfo(t *testing.T) {
	originalVersion := WorkerVersion
	originalCommit := BuildCommit
	originalDate := BuildDate
	t.Cleanup(func() {
		WorkerVersion = originalVersion
		BuildCommit = originalCommit
		BuildDate = originalDate
	})

	WorkerVersion = " v1.2.3 "
	BuildCommit = " abc123 "
	BuildDate = " 2026-07-21T12:00:00Z "

	got := CurrentBuildInfo()
	if got.Version != "v1.2.3" || got.Commit != "abc123" || got.Date != "2026-07-21T12:00:00Z" {
		t.Fatalf("unexpected build info: %#v", got)
	}
}

func TestCurrentBuildInfoDefaultsEmptyValues(t *testing.T) {
	originalVersion := WorkerVersion
	originalCommit := BuildCommit
	originalDate := BuildDate
	t.Cleanup(func() {
		WorkerVersion = originalVersion
		BuildCommit = originalCommit
		BuildDate = originalDate
	})

	WorkerVersion = ""
	BuildCommit = " "
	BuildDate = ""

	got := CurrentBuildInfo()
	if got.Version != "dev" || got.Commit != "unknown" || got.Date != "unknown" {
		t.Fatalf("unexpected default build info: %#v", got)
	}
}
