package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
)

var workerNames = []string{
	"Mexica", "London", "Paris", "Africa", "Kyoto", "Cairo", "Lima", "Nairobi", "Oslo", "Berlin",
	"Tokyo", "Seoul", "Lisbon", "Madrid", "Roma", "Athens", "Vienna", "Prague", "Dublin", "Zurich",
	"Havana", "Bogota", "Quito", "Andes", "Amazonas", "Patagonia", "Sahara", "Kalahari", "Atlas", "Nile",
	"Ganges", "Yukon", "Tundra", "Aurora", "Boreal", "Maya", "Inca", "Aztec", "Olmec", "Zapotec",
	"Tenochtitlan", "Uxmal", "Teotihuacan", "Chichen", "Palenque", "Oaxaca", "Sonora", "Yucatan", "Tulum", "Merida",
	"Barcelona", "Valencia", "Monaco", "Venice", "Florence", "Milan", "Napoli", "Sicilia", "Corsica", "Malta",
	"Casablanca", "Marrakesh", "Tunis", "Accra", "Lagos", "Kigali", "Zanzibar", "Serengeti", "Kilimanjaro", "Mombasa",
	"Mumbai", "Delhi", "Goa", "Jaipur", "Bali", "Java", "Sumatra", "Manila", "Saigon", "Hanoi",
	"Sydney", "Melbourne", "Auckland", "Tahiti", "Samoa", "Fiji", "Honolulu", "Alaska", "Vancouver", "Montreal",
	"Brooklyn", "Chicago", "Austin", "Denver", "Phoenix", "Seattle", "Portland", "Boston", "Miami", "Orleans",
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	settings, err := FromEnvironment()
	if err != nil {
		log.Fatalf("load settings: %v", err)
	}

	workerToken, err := ResolveWorkerToken(settings.DataDir)
	if err != nil {
		log.Fatalf("resolve worker token: %v", err)
	}
	workerTokenHash := SHA256Hex(workerToken)

	client, err := NewFirebaseClient(settings.FirebaseDatabaseURL, settings.ServiceAccountJSON)
	if err != nil {
		log.Fatalf("initialize firebase client: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	settings.WorkerLabel = resolveWorkerLabel(ctx, client, settings)
	agent := NewHeartbeatAgent(client, settings, workerTokenHash)
	runner := NewRunner(client, settings, agent)
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
			runner.StopAccepting()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			if err := agent.Send(shutdownCtx, "stopping", runner.ActiveCount()); err != nil {
				log.Printf("stopping heartbeat failed: %v", err)
			}
			cancel()
			log.Printf("Go worker %s waiting for %d active job(s)", settings.WorkerID, runner.ActiveCount())
			runner.Wait()
			offlineCtx, offlineCancel := context.WithTimeout(context.Background(), 8*time.Second)
			if err := agent.Send(offlineCtx, "offline", 0); err != nil {
				log.Printf("offline heartbeat failed: %v", err)
			}
			offlineCancel()
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

func resolveWorkerLabel(ctx context.Context, client *Client, settings Settings) string {
	agents := map[string]map[string]interface{}{}
	if err := client.Get(ctx, "workspaces/"+settings.WorkspaceID+"/agents", &agents); err != nil {
		log.Printf("could not read worker labels: %v", err)
		if strings.TrimSpace(settings.WorkerLabel) != "" {
			return strings.TrimSpace(settings.WorkerLabel)
		}
		return workerNames[0]
	}
	if current, ok := agents[settings.WorkerID]; ok {
		if previous := strings.TrimSpace(stringValue(current["label"])); previous != "" {
			return previous
		}
	}
	if configured := strings.TrimSpace(settings.WorkerLabel); configured != "" {
		return configured
	}
	used := map[string]bool{}
	for agentID, agent := range agents {
		if agentID == settings.WorkerID {
			continue
		}
		if label := strings.TrimSpace(stringValue(agent["label"])); label != "" {
			used[normalizedName(label)] = true
		}
	}
	for suffix := 1; ; suffix++ {
		for _, name := range workerNames {
			candidate := name
			if suffix > 1 {
				candidate = name + strconv.Itoa(suffix)
			}
			if !used[normalizedName(candidate)] {
				return candidate
			}
		}
	}
}

func normalizedName(value string) string {
	var builder strings.Builder
	for _, character := range value {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			builder.WriteRune(unicode.ToLower(character))
		}
	}
	return builder.String()
}
