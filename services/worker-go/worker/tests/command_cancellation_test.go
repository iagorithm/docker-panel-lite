package tests

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"docker-panel-lite-worker-go/worker/core"
)

func TestRunWorkerCommandContextCancelsActiveProcess(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	started := time.Now()

	result, err := core.RunWorkerCommandContext(ctx, "sh -c 'echo started; sleep 10'", "", nil, 30)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
	if result.ExitCode != 130 {
		t.Fatalf("expected cancellation exit code 130, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Output, "started") {
		t.Fatalf("expected partial command output, got %q", result.Output)
	}
	if time.Since(started) > 3*time.Second {
		t.Fatalf("cancelled command took too long to stop: %s", time.Since(started))
	}
}
