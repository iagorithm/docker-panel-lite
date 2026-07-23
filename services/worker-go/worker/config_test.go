package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCompiledConfigurationIgnoresProcessEnvironment(t *testing.T) {
	previous := Environment
	t.Cleanup(func() { Environment = previous })

	dataDir := filepath.Join(t.TempDir(), "data")
	Environment = CompiledEnvironment{
		FirebaseDatabaseURL: "https://compiled.example.test",
		ServiceAccountJSON:  `{}`,
		WorkspaceID:         "compiled-workspace",
		PoolID:              "compiled-pool",
		WorkerID:            "compiled-worker",
		QueueShardCount:     2,
		MaxConcurrency:      3,
		LeaseSeconds:        90,
		PollSeconds:         5,
		CloneDir:            filepath.Join(t.TempDir(), "clones"),
		DataDir:             dataDir,
		EncryptionKey:       "compiled-key",
		NgrokBin:            "ngrok",
	}

	t.Setenv("FIREBASE_DATABASE_URL", "https://runtime.example.test")
	t.Setenv("WORKER_WORKSPACE_ID", "runtime-workspace")
	t.Setenv("WORKER_ID", "runtime-worker")

	settings, err := FromCompiledEnvironment()
	if err != nil {
		t.Fatalf("load compiled configuration: %v", err)
	}
	if settings.FirebaseDatabaseURL != "https://compiled.example.test" {
		t.Fatalf("runtime environment changed database URL: %s", settings.FirebaseDatabaseURL)
	}
	if settings.WorkspaceID != "compiled-workspace" || settings.WorkerID != "compiled-worker" {
		t.Fatalf("runtime environment changed worker identity: workspace=%s worker=%s", settings.WorkspaceID, settings.WorkerID)
	}
	if _, err := os.Stat(dataDir); err == nil {
		t.Fatal("explicit compiled worker ID should not need to create the data directory")
	}
}
