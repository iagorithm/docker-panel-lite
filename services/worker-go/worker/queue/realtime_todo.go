package queue

import (
	"context"
	"errors"
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
// TODO: Subscribe to job changes, call cancel for cancellation or lease loss,
// wait for the active command/process group to stop, preserve partial output,
// and let the runner publish the terminal cancelled state. The watcher must
// exit when ctx is done and must not cancel a job owned by another worker.
func (r *Runner) WatchActiveCancellation(ctx context.Context, job Job, cancel context.CancelFunc) error {
	return errors.New("active job cancellation watcher is not implemented")
}
