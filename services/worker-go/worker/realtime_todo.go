package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var errRealtimeQueueNotImplemented = errors.New("Firebase realtime queue listener is not implemented")

// RunRealtime consumes Firebase Realtime Database queue events for every shard
// assigned to this worker.
//
// TODO: Open an authenticated streaming REST/SSE connection per configured
// shard, reconnect with bounded exponential backoff, apply put/patch events to
// a local queue view, honor targetWorkerId and available concurrency, and pass
// candidate job IDs through the existing ETag-based claim path. A disconnect
// must not lose jobs; polling should remain available as a recovery fallback.
func (r *Runner) RunRealtime(ctx context.Context) error {
	return errRealtimeQueueNotImplemented
}

// WatchActiveCancellation observes the leased Firebase job and cancels its
// execution context as soon as cancellationRequested becomes true or ownership
// of the lease is lost.
//
func (r *Runner) WatchActiveCancellation(ctx context.Context, job Job, cancel context.CancelFunc) error {
	jobID := stringValue(job["id"])
	if jobID == "" {
		return fmt.Errorf("cannot watch cancellation without a job ID")
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			current := Job{}
			if err := r.client.Get(ctx, "jobs/"+jobID, &current); err != nil {
				continue
			}
			if boolValue(current["cancellationRequested"]) {
				cancel()
				return nil
			}
			if workerID := stringValue(current["workerId"]); workerID != "" && workerID != r.settings.WorkerID {
				cancel()
				return fmt.Errorf("job lease moved to worker %s", workerID)
			}
			status := stringValue(current["status"])
			if status == "completed" || status == "failed" || status == "cancelled" {
				return nil
			}
		}
	}
}
