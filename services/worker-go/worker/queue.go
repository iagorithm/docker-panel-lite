package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"docker-panel-lite-worker-go/worker/core"
)

type Runner struct {
	client    *Client
	settings  Settings
	heartbeat *Agent

	mu        sync.Mutex
	scanMu    sync.Mutex
	active    map[string]bool
	accepting bool
	jobs      sync.WaitGroup
}

type Job map[string]interface{}

func NewRunner(client *Client, settings Settings, agent *Agent) *Runner {
	return &Runner{
		client:    client,
		settings:  settings,
		heartbeat: agent,
		active:    map[string]bool{},
		accepting: true,
	}
}

func (r *Runner) ActiveCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.active)
}

func (r *Runner) StopAccepting() {
	r.mu.Lock()
	r.accepting = false
	r.mu.Unlock()
}

func (r *Runner) Wait() {
	r.jobs.Wait()
}

func (r *Runner) Run(ctx context.Context) {
	go func() {
		if err := r.RunRealtime(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("realtime queue listener stopped: %v", err)
		}
	}()
	ticker := time.NewTicker(time.Duration(r.settings.PollSeconds) * time.Second)
	defer ticker.Stop()
	r.scan(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.scan(ctx)
		}
	}
}

func (r *Runner) scan(ctx context.Context) {
	r.scanMu.Lock()
	defer r.scanMu.Unlock()
	capacity := r.capacity()
	if capacity <= 0 {
		return
	}
	for _, shard := range r.settings.Shards {
		queued := map[string]map[string]interface{}{}
		if err := r.client.Get(ctx, queuePath(r.settings.PoolID, shard), &queued); err != nil {
			log.Printf("queue scan failed shard=%s: %v", shard, err)
			continue
		}
		jobIDs := sortedJobIDs(queued)
		for _, jobID := range jobIDs {
			if capacity <= 0 {
				return
			}
			queueItem := queued[jobID]
			if queueItem == nil {
				_ = r.client.Delete(ctx, queuePath(r.settings.PoolID, shard)+"/"+jobID)
				continue
			}
			if target := stringValue(queueItem["targetWorkerId"]); target != "" && target != r.settings.WorkerID {
				continue
			}
			if !r.markActive(jobID) {
				continue
			}
			capacity--
			go r.process(jobID, shard)
		}
	}
}

func (r *Runner) capacity() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.accepting {
		return 0
	}
	return r.settings.MaxConcurrency - len(r.active)
}

func (r *Runner) markActive(jobID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.accepting {
		return false
	}
	if r.active[jobID] {
		return false
	}
	r.active[jobID] = true
	r.jobs.Add(1)
	return true
}

func (r *Runner) clearActive(jobID string) {
	defer r.jobs.Done()
	r.mu.Lock()
	delete(r.active, jobID)
	active := len(r.active)
	r.mu.Unlock()
	if err := r.heartbeat.Send(context.Background(), "online", active); err != nil {
		log.Printf("post-job heartbeat failed: %v", err)
	}
}

func (r *Runner) process(jobID string, shard string) {
	ctx := context.Background()
	var job Job
	var renewalCancel context.CancelFunc
	defer r.clearActive(jobID)
	defer func() {
		if renewalCancel != nil {
			renewalCancel()
		}
	}()

	claimed, err := r.claim(ctx, jobID)
	if err != nil {
		log.Printf("job %s claim failed: %v", jobID, err)
		r.recordAppError(ctx, "unknown_job", "worker.claim", Job{"id": jobID, "workspaceId": r.settings.WorkspaceID}, err)
		_ = r.fail(ctx, Job{"id": jobID, "workspaceId": r.settings.WorkspaceID}, err)
		_ = r.client.Delete(ctx, queuePath(r.settings.PoolID, shard)+"/"+jobID)
		return
	}
	if claimed == nil {
		current := Job{}
		_ = r.client.Get(ctx, "jobs/"+jobID, &current)
		status := stringValue(current["status"])
		if current["id"] == nil || status == "completed" || status == "failed" || status == "cancelled" {
			_ = r.client.Delete(ctx, queuePath(r.settings.PoolID, shard)+"/"+jobID)
		}
		return
	}
	job = claimed
	if stringValue(job["workspaceId"]) != r.settings.WorkspaceID {
		err := fmt.Errorf("worker is not assigned to this workspace")
		_ = r.fail(ctx, job, err)
		_ = r.client.Delete(ctx, queuePath(r.settings.PoolID, shard)+"/"+jobID)
		return
	}
	if ok, err := r.acquireLock(ctx, job); err != nil || !ok {
		if err != nil {
			log.Printf("job %s lock failed: %v", jobID, err)
		}
		_ = r.publish(ctx, job, map[string]interface{}{"status": "queued", "workerId": nil, "leaseExpiresAt": nil, "message": "Waiting for repository lock"})
		return
	}
	defer r.releaseLock(ctx, job)

	if err := r.publish(ctx, job, map[string]interface{}{"status": "running", "progress": 10, "message": "Worker claimed deployment"}); err != nil {
		log.Printf("job %s publish running failed: %v", jobID, err)
	}
	renewCtx, cancel := context.WithCancel(ctx)
	renewalCancel = cancel
	go r.renewLease(renewCtx, job)

	executionCtx, executionCancel := context.WithCancel(ctx)
	watchCtx, stopWatching := context.WithCancel(ctx)
	defer executionCancel()
	defer stopWatching()
	go func() {
		if err := r.WatchActiveCancellation(watchCtx, job, executionCancel); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("job %s cancellation watcher stopped: %v", jobID, err)
		}
	}()

	message, err := r.execute(executionCtx, job)
	stopWatching()
	if err != nil {
		current := Job{}
		_ = r.client.Get(ctx, "jobs/"+jobID, &current)
		if errors.Is(err, context.Canceled) && boolValue(current["cancellationRequested"]) {
			_ = r.publish(ctx, job, map[string]interface{}{"status": "cancelled", "message": "Cancelled during execution", "finishedAt": nowMillis(), "leaseExpiresAt": nil})
			_ = r.client.Delete(ctx, queuePath(r.settings.PoolID, shard)+"/"+jobID)
			log.Printf("job %s cancelled during execution", jobID)
			return
		}
		log.Printf("job %s failed: %v", jobID, err)
		r.recordAppError(ctx, stringValue(job["action"]), "worker.job", job, err)
		r.markTunnelFailure(ctx, job, err)
		_ = r.fail(ctx, job, err)
		_ = r.client.Delete(ctx, queuePath(r.settings.PoolID, shard)+"/"+jobID)
		return
	}
	current := Job{}
	_ = r.client.Get(ctx, "jobs/"+jobID, &current)
	status := "completed"
	if boolValue(current["cancellationRequested"]) {
		status = "cancelled"
	}
	_ = r.publish(ctx, job, map[string]interface{}{"status": status, "progress": 100, "message": message, "finishedAt": nowMillis(), "leaseExpiresAt": nil})
	_ = r.client.Delete(ctx, queuePath(r.settings.PoolID, shard)+"/"+jobID)
	log.Printf("job %s %s: %s", jobID, status, message)
}

func (r *Runner) claim(ctx context.Context, jobID string) (Job, error) {
	for attempt := 0; attempt < 3; attempt++ {
		job := Job{}
		etag, err := r.client.GetWithETag(ctx, "jobs/"+jobID, &job)
		if err != nil {
			return nil, err
		}
		if job["id"] == nil && job["workspaceId"] == nil {
			return nil, nil
		}
		timestamp := nowMillis()
		status := stringValue(job["status"])
		if status == "completed" || status == "failed" || status == "cancelled" {
			return nil, nil
		}
		if target := stringValue(job["targetWorkerId"]); target != "" && target != r.settings.WorkerID {
			return nil, nil
		}
		leaseExpired := int64Value(job["leaseExpiresAt"]) < timestamp
		if (status != "queued" && status != "leased" && status != "running") || (stringValue(job["workerId"]) != "" && !leaseExpired) {
			return nil, nil
		}
		if boolValue(job["cancellationRequested"]) {
			job["status"] = "cancelled"
			job["finishedAt"] = timestamp
			job["message"] = "Cancelled before execution"
		} else {
			job["status"] = "leased"
			job["workerId"] = r.settings.WorkerID
			job["leaseExpiresAt"] = timestamp + int64(r.settings.LeaseSeconds*1000)
			job["attempt"] = intValue(job["attempt"]) + 1
			if int64Value(job["startedAt"]) == 0 {
				job["startedAt"] = timestamp
			}
		}
		var updated Job
		ok, err := r.client.PutIfMatch(ctx, "jobs/"+jobID, etag, job, &updated)
		if err != nil {
			return nil, err
		}
		if ok {
			if stringValue(updated["workerId"]) == r.settings.WorkerID && stringValue(updated["status"]) == "leased" {
				return updated, nil
			}
			return nil, nil
		}
	}
	return nil, nil
}

func (r *Runner) execute(ctx context.Context, job Job) (string, error) {
	action := stringValue(job["action"])
	if err := r.publish(ctx, job, map[string]interface{}{"progress": 25, "message": "Executing " + jobActionLabel(action)}); err != nil {
		log.Printf("job publish progress failed: %v", err)
	}
	switch action {
	case "inventory_refresh":
		if err := r.PublishContainerInventory(ctx, stringValue(job["workspaceId"]), false); err != nil {
			return "", err
		}
		return "Container inventory refreshed", nil
	case "worker_command":
		var repository map[string]interface{}
		repositoryID := stringValue(job["repositoryId"])
		if repositoryID != "" {
			repository = map[string]interface{}{}
			if err := r.client.Get(ctx, fmt.Sprintf("workspaces/%s/repositories/%s", stringValue(job["workspaceId"]), repositoryID), &repository); err != nil {
				return "", err
			}
			if len(repository) == 0 {
				return "", fmt.Errorf("repository no longer exists")
			}
		}
		result, err := ExecuteWorkerCommand(ctx, r.client, job, repository, r.settings)
		if err != nil {
			return "", err
		}
		if result.Command != nil {
			_ = r.publish(ctx, job, map[string]interface{}{"commandOutput": result.Command.Output, "commandExitCode": result.Command.ExitCode})
			if result.Command.ExitCode != 0 {
				return "", fmt.Errorf("%s", result.Command.Message)
			}
		}
		return result.Message, nil
	case "container_exec":
		result, err := core.ContainerExecContext(ctx, containerCandidates(job), stringValue(job["command"]), intValue(job["timeoutSeconds"]))
		if err != nil {
			return "", err
		}
		_ = r.publish(ctx, job, map[string]interface{}{"commandOutput": result.Output, "commandExitCode": result.ExitCode})
		if result.ExitCode != 0 {
			return "", fmt.Errorf("%s", result.Message)
		}
		return result.Message, nil
	case "container_tunnel_start":
		message, updates, err := executeContainerTunnel(job, r.settings)
		if err != nil {
			return "", err
		}
		containerID := stringValue(job["containerId"])
		if containerID == "" {
			return "", fmt.Errorf("container reference is missing")
		}
		if err := r.client.Patch(ctx, fmt.Sprintf("workspaces/%s/containers/%s", stringValue(job["workspaceId"]), containerID), updates); err != nil {
			return "", err
		}
		return message, nil
	case "container_start", "container_stop", "container_restart", "container_delete", "container_logs":
		message, logTail, err := core.ContainerAction(action, containerCandidates(job))
		if err != nil {
			return "", err
		}
		if logTail != nil {
			_ = r.client.Put(ctx, fmt.Sprintf("workspaces/%s/containers/%s/logTail", stringValue(job["workspaceId"]), stringValue(job["containerId"])), *logTail)
		} else {
			_ = r.PublishContainerInventory(ctx, stringValue(job["workspaceId"]), false)
		}
		return message, nil
	default:
		repositoryID := stringValue(job["repositoryId"])
		if repositoryID == "" {
			return "", fmt.Errorf("action '%s' requires a repositoryId", action)
		}
		repository := map[string]interface{}{}
		if err := r.client.Get(ctx, fmt.Sprintf("workspaces/%s/repositories/%s", stringValue(job["workspaceId"]), repositoryID), &repository); err != nil {
			return "", err
		}
		if len(repository) == 0 {
			return "", fmt.Errorf("repository no longer exists")
		}
		result, err := Execute(ctx, r.client, job, repository, r.settings)
		if err != nil {
			return "", err
		}
		if len(result.Updates) > 0 {
			if err := r.client.Patch(ctx, fmt.Sprintf("workspaces/%s/repositories/%s", stringValue(job["workspaceId"]), repositoryID), result.Updates); err != nil {
				return "", err
			}
		}
		return result.Message, nil
	}
}

func (r *Runner) PublishContainerInventory(ctx context.Context, workspaceID string, resetWorkerRecords bool) error {
	inventory, err := core.ContainerInventory()
	if err != nil {
		return err
	}
	existing := map[string]map[string]interface{}{}
	_ = r.client.Get(ctx, fmt.Sprintf("workspaces/%s/containers", workspaceID), &existing)
	updates := map[string]interface{}{}
	seen := map[string]bool{}
	now := nowMillis()
	for dockerID, item := range inventory {
		name := stringValue(item["name"])
		recordID := containerRecordID(r.settings.WorkerID, nameOrDefault(name, dockerID))
		previous := map[string]interface{}{}
		if !resetWorkerRecords {
			if value, ok := existing[recordID]; ok {
				previous = value
			} else if value, ok := existing[dockerID]; ok {
				previous = value
			}
		}
		seen[recordID] = true
		isWorker := core.IsWorkerContainerName(name) || stringValue(item["composeService"]) == "worker"
		updated := map[string]interface{}{}
		for key, value := range previous {
			updated[key] = value
		}
		for key, value := range item {
			updated[key] = value
		}
		updated["id"] = recordID
		updated["dockerId"] = dockerID
		updated["workerId"] = r.settings.WorkerID
		updated["workerLabel"] = r.settings.WorkerLabelOrDefault()
		updated["workerHostname"] = r.settings.Hostname
		updated["poolId"] = r.settings.PoolID
		updated["isWorkerContainer"] = isWorker
		if isWorker {
			updated["protectedActions"] = []string{"container_stop", "container_delete", "container_exec"}
		} else {
			updated["protectedActions"] = []string{}
		}
		updated["lastSeenAt"] = now
		updated["updatedAt"] = now
		updated["missingSince"] = nil
		if updated["createdAt"] == nil {
			updated["createdAt"] = now
		}
		if previous["logTail"] != nil {
			updated["logTail"] = previous["logTail"]
		}
		updates[fmt.Sprintf("workspaces/%s/containers/%s", workspaceID, recordID)] = updated
		if dockerID != recordID {
			if _, ok := existing[dockerID]; ok {
				updates[fmt.Sprintf("workspaces/%s/containers/%s", workspaceID, dockerID)] = nil
			}
		}
	}
	for containerID, item := range existing {
		if !recordBelongsToWorker(containerID, item, r.settings.WorkerID, r.settings.WorkerLabelOrDefault(), r.settings.Hostname) {
			continue
		}
		if !seen[containerID] {
			updates[fmt.Sprintf("workspaces/%s/containers/%s", workspaceID, containerID)] = nil
		}
	}
	if len(updates) == 0 {
		return nil
	}
	return r.client.Patch(ctx, "", updates)
}

func (r *Runner) publish(ctx context.Context, job Job, values map[string]interface{}) error {
	jobID := stringValue(job["id"])
	workspaceID := stringValue(job["workspaceId"])
	updates := map[string]interface{}{}
	for key, value := range values {
		updates[fmt.Sprintf("jobs/%s/%s", jobID, key)] = value
		updates[fmt.Sprintf("workspaces/%s/deployments/%s/%s", workspaceID, jobID, key)] = value
	}
	return r.client.Patch(ctx, "", updates)
}

func (r *Runner) fail(ctx context.Context, job Job, err error) error {
	return r.publish(ctx, job, map[string]interface{}{"status": "failed", "message": truncate(err.Error(), 1000), "finishedAt": nowMillis(), "leaseExpiresAt": nil})
}

func (r *Runner) markTunnelFailure(ctx context.Context, job Job, jobErr error) {
	action := stringValue(job["action"])
	var path string
	if action == "tunnel_start" && stringValue(job["repositoryId"]) != "" {
		path = fmt.Sprintf("workspaces/%s/repositories/%s", stringValue(job["workspaceId"]), stringValue(job["repositoryId"]))
	} else if action == "container_tunnel_start" && stringValue(job["containerId"]) != "" {
		path = fmt.Sprintf("workspaces/%s/containers/%s", stringValue(job["workspaceId"]), stringValue(job["containerId"]))
	}
	if path == "" {
		return
	}
	_ = r.client.Patch(ctx, path, map[string]interface{}{
		"publicUrl":             "",
		"publicUrls":            map[string]interface{}{},
		"publicTunnels":         map[string]interface{}{},
		"publicTunnelStatus":    "error",
		"publicTunnelError":     truncate(jobErr.Error(), 1000),
		"publicTunnelUpdatedAt": nowMillis(),
	})
}

func (r *Runner) recordAppError(ctx context.Context, action string, source string, job Job, jobErr error) {
	message := jobErr.Error()
	message = regexp.MustCompile(`(?i)([?&](?:access_token|token|key)=)[^&\s]+`).ReplaceAllString(message, `${1}[REDACTED]`)
	id := fmt.Sprintf("%d-%s-%s-%s", nowMillis(), normalizeRecordPart(r.settings.WorkerID), normalizeRecordPart(stringValue(job["id"])), randomHex(4))
	payload := map[string]interface{}{
		"id":           id,
		"actorType":    "worker",
		"actorId":      r.settings.WorkerID,
		"actorLabel":   r.settings.WorkerLabelOrDefault(),
		"userId":       stringValue(job["requestedBy"]),
		"userEmail":    stringValue(job["requestedByEmail"]),
		"runtime":      "worker-go",
		"functionName": truncate(source, 240),
		"action":       truncate(nameOrDefault(action, "worker_runtime"), 120),
		"source":       truncate(nameOrDefault(source, "worker"), 160),
		"severity":     "error",
		"message":      truncate(message, 2000),
		"createdAt":    nowMillis(),
		"context": map[string]interface{}{
			"jobId":            stringValue(job["id"]),
			"repositoryId":     stringValue(job["repositoryId"]),
			"containerId":      stringValue(job["containerId"]),
			"targetWorkerId":   stringValue(job["targetWorkerId"]),
			"requestedBy":      stringValue(job["requestedBy"]),
			"requestedByEmail": stringValue(job["requestedByEmail"]),
		},
	}
	if err := r.client.Put(ctx, fmt.Sprintf("workspaces/%s/app_logs/%s", r.settings.WorkspaceID, id), payload); err != nil {
		log.Printf("could not publish app log: %v", err)
	}
}

func (r *Runner) acquireLock(ctx context.Context, job Job) (bool, error) {
	lockKey := lockKey(job)
	path := fmt.Sprintf("locks/%s/%s", stringValue(job["workspaceId"]), lockKey)
	for attempt := 0; attempt < 3; attempt++ {
		current := map[string]interface{}{}
		etag, err := r.client.GetWithETag(ctx, path, &current)
		if err != nil {
			return false, err
		}
		now := nowMillis()
		if current["jobId"] != nil && int64Value(current["expiresAt"]) >= now && stringValue(current["jobId"]) != stringValue(job["id"]) {
			return false, nil
		}
		next := map[string]interface{}{"jobId": stringValue(job["id"]), "workerId": r.settings.WorkerID, "expiresAt": now + int64(r.settings.LeaseSeconds*1000)}
		var updated map[string]interface{}
		ok, err := r.client.PutIfMatch(ctx, path, etag, next, &updated)
		if err != nil {
			return false, err
		}
		if ok {
			return stringValue(updated["jobId"]) == stringValue(job["id"]) && stringValue(updated["workerId"]) == r.settings.WorkerID, nil
		}
	}
	return false, nil
}

func (r *Runner) releaseLock(ctx context.Context, job Job) {
	path := fmt.Sprintf("locks/%s/%s", stringValue(job["workspaceId"]), lockKey(job))
	current := map[string]interface{}{}
	if err := r.client.Get(ctx, path, &current); err != nil {
		return
	}
	if stringValue(current["jobId"]) == stringValue(job["id"]) {
		_ = r.client.Delete(ctx, path)
	}
}

func (r *Runner) renewLease(ctx context.Context, job Job) {
	interval := time.Duration(maxInt(10, r.settings.LeaseSeconds/3)) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			current := Job{}
			if err := r.client.Get(ctx, "jobs/"+stringValue(job["id"]), &current); err != nil {
				log.Printf("lease renewal read failed job=%s: %v", stringValue(job["id"]), err)
				return
			}
			if stringValue(current["workerId"]) != r.settings.WorkerID || boolValue(current["cancellationRequested"]) {
				return
			}
			expiresAt := nowMillis() + int64(r.settings.LeaseSeconds*1000)
			_ = r.publish(ctx, job, map[string]interface{}{"leaseExpiresAt": expiresAt})
			_ = r.client.Put(ctx, fmt.Sprintf("locks/%s/%s/expiresAt", stringValue(job["workspaceId"]), lockKey(job)), expiresAt)
		}
	}
}

func queuePath(poolID string, shard string) string {
	return fmt.Sprintf("queues/%s/%s", poolID, shard)
}

func sortedJobIDs(queued map[string]map[string]interface{}) []string {
	ids := make([]string, 0, len(queued))
	for id := range queued {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		return int64Value(queued[ids[i]]["createdAt"]) < int64Value(queued[ids[j]]["createdAt"])
	})
	return ids
}

func containerCandidates(job Job) []string {
	candidates := []string{stringValue(job["containerRef"]), stringValue(job["containerId"])}
	for _, value := range append([]string{}, candidates...) {
		if strings.Contains(value, "--") {
			candidates = append(candidates, strings.SplitN(value, "--", 2)[1])
		}
	}
	return candidates
}

func lockKey(job Job) string {
	if repositoryID := stringValue(job["repositoryId"]); repositoryID != "" {
		return repositoryID
	}
	containerID := stringValue(job["containerId"])
	if containerID == "" {
		containerID = "unknown"
	}
	return "container-" + containerID
}

func containerRecordID(workerID string, containerName string) string {
	safe := strings.Trim(normalizeRecordPart(containerName), "-")
	if safe == "" {
		safe = "container"
	}
	return workerID + "--" + safe
}

func normalizeRecordPart(value string) string {
	builder := strings.Builder{}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			builder.WriteRune(char)
		} else {
			builder.WriteRune('-')
		}
	}
	return builder.String()
}

func recordBelongsToWorker(recordID string, item map[string]interface{}, workerID string, workerLabel string, hostname string) bool {
	if stringValue(item["workerId"]) == workerID || strings.HasPrefix(recordID, workerID+"--") {
		return true
	}
	if workerLabel != "" && normalizeComparable(stringValue(item["workerLabel"])) == normalizeComparable(workerLabel) {
		return true
	}
	return hostname != "" && stringValue(item["workerHostname"]) == hostname
}

func normalizeComparable(value string) string {
	builder := strings.Builder{}
	for _, char := range strings.ToLower(value) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func jobActionLabel(action string) string {
	labels := map[string]string{
		"inventory_refresh": "refresh container inventory",
		"container_start":   "start container",
		"container_stop":    "stop container",
		"container_restart": "restart container",
		"container_delete":  "delete container",
		"container_logs":    "load container logs",
		"container_exec":    "run container command",
		"worker_command":    "run worker command",
		"sync":              "sync repository",
		"deploy":            "deploy compose stack",
		"build":             "build Dockerfile container",
		"discover_branches": "discover branches",
		"read_compose":      "read Compose file",
		"read_dockerfile":   "read Dockerfile",
		"tunnel_start":      "open public URL",
		"tunnel_stop":       "close public URL",
	}
	if label, ok := labels[action]; ok {
		return label
	}
	return action
}

func int64Value(value interface{}) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		if err == nil {
			return parsed
		}
	}
	return 0
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func nameOrDefault(name string, fallback string) string {
	if strings.TrimSpace(name) != "" {
		return name
	}
	return fallback
}
