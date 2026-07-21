package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"docker-panel-lite-worker-go/worker/config"
	"docker-panel-lite-worker-go/worker/firebase_runtime"
	"docker-panel-lite-worker-go/worker/heartbeat"
	"docker-panel-lite-worker-go/worker/identity"
	"docker-panel-lite-worker-go/worker/queue"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	settings, err := config.FromEnvironment()
	if err != nil {
		log.Fatalf("load settings: %v", err)
	}

	workerToken, err := identity.ResolveWorkerToken(settings.DataDir)
	if err != nil {
		log.Fatalf("resolve worker token: %v", err)
	}
	workerTokenHash := identity.SHA256Hex(workerToken)

	client, err := firebase_runtime.New(settings.FirebaseDatabaseURL, settings.ServiceAccountJSON)
	if err != nil {
		log.Fatalf("initialize firebase client: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	agent := heartbeat.New(client, settings, workerTokenHash)
	runner := queue.New(client, settings, agent)
	log.Printf("Worker claim token for %s (%s): %s", settings.WorkerID, settings.WorkerLabelOrDefault(), workerToken)

	if err := agent.Send(ctx, "online", 0); err != nil {
		log.Printf("heartbeat failed: %v", err)
	}
	if err := runner.PublishContainerInventory(ctx, settings.WorkspaceID, true); err != nil {
		log.Printf("container inventory failed: %v", err)
	}
	go runner.Run(ctx)

	ticker := time.NewTicker(time.Duration(settings.PollSeconds) * time.Second)
	defer ticker.Stop()

	log.Printf("Go worker %s (%s) online pool=%s shards=%v", settings.WorkerID, settings.WorkerLabelOrDefault(), settings.PoolID, settings.Shards)
	for {
		select {
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			if err := agent.Send(shutdownCtx, "offline", runner.ActiveCount()); err != nil {
				log.Printf("offline heartbeat failed: %v", err)
			}
			log.Printf("Go worker %s stopped", settings.WorkerID)
			return
		case <-ticker.C:
			if err := agent.Send(ctx, "online", runner.ActiveCount()); err != nil {
				log.Printf("heartbeat failed: %v", err)
			}
			if err := runner.PublishContainerInventory(ctx, settings.WorkspaceID, false); err != nil {
				log.Printf("container inventory failed: %v", err)
			}
		}
	}
}
