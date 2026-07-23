package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RunRealtime listens to every assigned Firebase queue shard through the REST
// streaming protocol. Periodic polling remains active as a recovery path when
// a stream disconnects or an event is missed.
func (r *Runner) RunRealtime(ctx context.Context) error {
	var listeners sync.WaitGroup
	for _, shard := range r.settings.Shards {
		shard := shard
		listeners.Add(1)
		go func() {
			defer listeners.Done()
			r.listenQueueShard(ctx, shard)
		}()
	}
	<-ctx.Done()
	listeners.Wait()
	return ctx.Err()
}

func (r *Runner) listenQueueShard(ctx context.Context, shard string) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := r.consumeQueueStream(ctx, shard)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			r.recordAppError(ctx, "queue_stream", "worker.realtime", Job{}, err)
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (r *Runner) consumeQueueStream(ctx context.Context, shard string) error {
	token, err := r.client.token(ctx)
	if err != nil {
		return err
	}
	request, err := r.client.authenticatedRequest(ctx, http.MethodGet, queuePath(r.settings.PoolID, shard), token, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "text/event-stream")
	response, err := r.client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2000))
		return fmt.Errorf("firebase queue stream %s failed: %s: %s", shard, response.Status, strings.TrimSpace(string(body)))
	}

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 2*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "null" {
			continue
		}
		r.scan(ctx)
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return fmt.Errorf("firebase queue stream %s closed", shard)
}

// WatchActiveCancellation observes the leased Firebase job and cancels its
// execution context as soon as cancellationRequested becomes true or ownership
// of the lease is lost.
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
