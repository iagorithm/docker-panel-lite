package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) != 3 {
		fatal("usage: generate-environment <worker.env> <output.go>")
	}
	values, err := readEnvironment(os.Args[1])
	if err != nil {
		fatal(err.Error())
	}
	required := []string{"FIREBASE_SERVICE_ACCOUNT_JSON", "CREDENTIAL_ENCRYPTION_KEY"}
	for _, key := range required {
		if strings.TrimSpace(values[key]) == "" {
			fatal(key + " is required to compile the Go worker")
		}
	}
	databaseURL := first(values, "FIREBASE_DATABASE_URL", "NEXT_PUBLIC_FIREBASE_DATABASE_URL")
	if databaseURL == "" {
		fatal("FIREBASE_DATABASE_URL or NEXT_PUBLIC_FIREBASE_DATABASE_URL is required to compile the Go worker")
	}

	source := fmt.Sprintf(`package main

func init() {
	Environment = CompiledEnvironment{
		FirebaseDatabaseURL: %q,
		ServiceAccountJSON: %q,
		WorkspaceID: %q,
		PoolID: %q,
		WorkerID: %q,
		WorkerMachineID: %q,
		WorkerToken: %q,
		WorkerLabel: %q,
		WorkerLocation: %q,
		WorkerShards: %#v,
		QueueShardCount: %d,
		MaxConcurrency: %d,
		LeaseSeconds: %d,
		PollSeconds: %d,
		CloneDir: "/app/clones",
		DataDir: "/app/data",
		EncryptionKey: %q,
		NgrokEnabled: %t,
		NgrokAuthtoken: %q,
		NgrokBin: %q,
		NgrokRegion: %q,
	}
}
`, databaseURL,
		values["FIREBASE_SERVICE_ACCOUNT_JSON"],
		fallback(first(values, "WORKER_WORKSPACE_ID", "DEFAULT_WORKSPACE_ID"), "default"),
		fallback(first(values, "WORKER_GO_POOL", "WORKER_POOL"), "default"),
		first(values, "WORKER_GO_ID", "WORKER_ID"),
		first(values, "WORKER_GO_MACHINE_ID", "WORKER_MACHINE_ID", "HOST_MACHINE_ID"),
		first(values, "WORKER_GO_TOKEN", "WORKER_TOKEN"),
		first(values, "WORKER_GO_LABEL", "WORKER_LABEL"),
		first(values, "WORKER_GO_LOCATION", "WORKER_LOCATION"),
		csv(first(values, "WORKER_GO_SHARDS", "WORKER_SHARDS")),
		integer(values, 16, "QUEUE_SHARDS"),
		integer(values, 2, "WORKER_GO_MAX_CONCURRENCY", "WORKER_MAX_CONCURRENCY"),
		integer(values, 90, "WORKER_GO_LEASE_SECONDS", "WORKER_LEASE_SECONDS"),
		integer(values, 5, "WORKER_GO_POLL_SECONDS", "WORKER_POLL_SECONDS"),
		values["CREDENTIAL_ENCRYPTION_KEY"],
		boolean(first(values, "NGROK_GO_ENABLED", "NGROK_ENABLED")) || first(values, "NGROK_GO_AUTHTOKEN", "NGROK_AUTHTOKEN") != "",
		first(values, "NGROK_GO_AUTHTOKEN", "NGROK_AUTHTOKEN"),
		fallback(first(values, "NGROK_GO_BIN", "NGROK_BIN"), "ngrok"),
		first(values, "NGROK_GO_REGION", "NGROK_REGION"),
	)
	if err := os.WriteFile(os.Args[2], []byte(source), 0600); err != nil {
		fatal(err.Error())
	}
}

func readEnvironment(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	values := map[string]string{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		if len(value) >= 2 && value[0] == value[len(value)-1] && (value[0] == '\'' || value[0] == '"') {
			value = value[1 : len(value)-1]
		}
		values[key] = value
	}
	return values, scanner.Err()
}

func first(values map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(values[key]); value != "" {
			return value
		}
	}
	return ""
}

func fallback(value, defaultValue string) string {
	if strings.TrimSpace(value) == "" {
		return defaultValue
	}
	return value
}

func integer(values map[string]string, defaultValue int, keys ...string) int {
	value, err := strconv.Atoi(first(values, keys...))
	if err != nil || value < 1 {
		return defaultValue
	}
	return value
}

func boolean(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on", "enabled":
		return true
	default:
		return false
	}
}

func csv(value string) []string {
	result := []string{}
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
