package config

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/ioutil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type Settings struct {
	FirebaseDatabaseURL  string
	ServiceAccountJSON   string
	WorkspaceID          string
	PoolID               string
	WorkerID             string
	WorkerIdentitySource string
	WorkerLabel          string
	WorkerLocation       string
	Hostname             string
	Shards               []string
	MaxConcurrency       int
	LeaseSeconds         int
	PollSeconds          int
	CloneDir             string
	DataDir              string
	EncryptionKey        string
	TraefikEnabled       bool
	TraefikNetwork       string
	NgrokEnabled         bool
	NgrokAuthtoken       string
	NgrokBin             string
	NgrokRegion          string
}

func FromEnvironment() (Settings, error) {
	loadEnvironmentFile()

	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "worker"
	}

	serviceAccountJSON := serviceAccountJSON()
	databaseURL, err := firebaseDatabaseURL(serviceAccountJSON)
	if err != nil {
		return Settings{}, err
	}

	dataDir := abs(envDefault("APP_DATA_DIR", "/app/data"))
	cloneDir := abs(envDefault("APP_CLONE_DIR", "/app/clones"))
	poolID := envDefault("WORKER_POOL", "default")
	workerID, source := workerID(hostname, dataDir, poolID)
	shards := configuredShards(integer("QUEUE_SHARDS", 16, 1))
	ngrokToken := strings.TrimSpace(os.Getenv("NGROK_AUTHTOKEN"))

	settings := Settings{
		FirebaseDatabaseURL:  databaseURL,
		ServiceAccountJSON:   serviceAccountJSON,
		WorkspaceID:          envDefault("WORKER_WORKSPACE_ID", "default"),
		PoolID:               poolID,
		WorkerID:             workerID,
		WorkerIdentitySource: source,
		WorkerLabel:          strings.TrimSpace(os.Getenv("WORKER_LABEL")),
		WorkerLocation:       strings.TrimSpace(os.Getenv("WORKER_LOCATION")),
		Hostname:             hostname,
		Shards:               shards,
		MaxConcurrency:       integer("WORKER_MAX_CONCURRENCY", 2, 1),
		LeaseSeconds:         integer("WORKER_LEASE_SECONDS", 90, 30),
		PollSeconds:          integer("WORKER_POLL_SECONDS", 5, 1),
		CloneDir:             cloneDir,
		DataDir:              dataDir,
		EncryptionKey:        os.Getenv("CREDENTIAL_ENCRYPTION_KEY"),
		TraefikEnabled:       boolean("TRAEFIK_ENABLED", false),
		TraefikNetwork:       envDefault("TRAEFIK_NETWORK", "proxy"),
		NgrokEnabled:         boolean("NGROK_ENABLED", ngrokToken != ""),
		NgrokAuthtoken:       ngrokToken,
		NgrokBin:             envDefault("NGROK_BIN", "ngrok"),
		NgrokRegion:          strings.TrimSpace(os.Getenv("NGROK_REGION")),
	}
	if settings.EncryptionKey == "" {
		return Settings{}, errors.New("CREDENTIAL_ENCRYPTION_KEY is not configured")
	}
	return settings, nil
}

func (s Settings) WorkerLabelOrDefault() string {
	if strings.TrimSpace(s.WorkerLabel) != "" {
		return strings.TrimSpace(s.WorkerLabel)
	}
	return "Go"
}

func loadEnvironmentFile() {
	path := strings.TrimSpace(envDefault("WORKER_CONFIG_FILE", "/app/config/worker.env"))
	if path == "" {
		return
	}
	data, err := ioutil.ReadFile(path)
	if err != nil {
		return
	}
	keyPattern := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		key := strings.TrimSpace(parts[0])
		if !keyPattern.MatchString(key) || os.Getenv(key) != "" {
			continue
		}
		os.Setenv(key, unquoteEnvValue(parts[1]))
	}
}

func unquoteEnvValue(value string) string {
	text := strings.TrimSpace(value)
	if len(text) < 2 {
		return text
	}
	quote := text[0]
	if (quote == '"' || quote == '\'') && text[len(text)-1] == quote {
		inner := text[1 : len(text)-1]
		if quote == '"' {
			inner = strings.ReplaceAll(inner, `\n`, "\n")
			inner = strings.ReplaceAll(inner, `\"`, `"`)
		}
		return inner
	}
	return text
}

func envDefault(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value != "" {
		return value
	}
	return fallback
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func integer(key string, fallback, minimum int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil {
		value = fallback
	}
	if value < minimum {
		return minimum
	}
	return value
}

func boolean(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	switch value {
	case "1", "true", "yes", "on", "enabled":
		return true
	default:
		return false
	}
}

func serviceAccountJSON() string {
	if raw := strings.TrimSpace(os.Getenv("FIREBASE_SERVICE_ACCOUNT_JSON")); raw != "" {
		return raw
	}
	path := firstEnv("FIREBASE_SERVICE_ACCOUNT_FILE", "GOOGLE_APPLICATION_CREDENTIALS")
	if path == "" {
		return ""
	}
	data, err := ioutil.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func firebaseDatabaseURL(serviceAccount string) (string, error) {
	if configured := firstEnv("FIREBASE_DATABASE_URL", "NEXT_PUBLIC_FIREBASE_DATABASE_URL"); configured != "" {
		return strings.TrimRight(configured, "/"), nil
	}
	projectID := firstEnv("FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT")
	if projectID == "" && serviceAccount != "" {
		var payload map[string]interface{}
		if err := json.Unmarshal([]byte(serviceAccount), &payload); err == nil {
			if value, ok := payload["project_id"].(string); ok {
				projectID = strings.TrimSpace(value)
			}
		}
	}
	if projectID == "" {
		return "", errors.New("configure FIREBASE_DATABASE_URL or NEXT_PUBLIC_FIREBASE_DATABASE_URL")
	}
	return fmt.Sprintf("https://%s-default-rtdb.firebaseio.com", projectID), nil
}

func abs(path string) string {
	resolved, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return resolved
}

func safeWorkerPart(value string) string {
	re := regexp.MustCompile(`[^A-Za-z0-9_-]+`)
	cleaned := strings.Trim(re.ReplaceAllString(strings.TrimSpace(value), "-"), "-")
	if cleaned == "" {
		return "default"
	}
	return strings.ToLower(cleaned)
}

func dockerHostFingerprint() (string, string) {
	if configured := firstEnv("WORKER_MACHINE_ID", "HOST_MACHINE_ID"); configured != "" {
		return configured, "env"
	}
	output, err := exec.Command("docker", "info", "--format", "{{.ID}}|{{.Name}}").Output()
	if err == nil {
		value := strings.TrimSpace(string(output))
		if value != "" && value != "|" {
			return value, "docker"
		}
	}
	data, err := ioutil.ReadFile("/etc/machine-id")
	if err == nil && strings.TrimSpace(string(data)) != "" {
		return strings.TrimSpace(string(data)), "machine-id"
	}
	return "", ""
}

func generatedWorkerID(poolID, fingerprint string) string {
	sum := sha256.Sum256([]byte(fingerprint))
	return fmt.Sprintf("worker-%s-%s", safeWorkerPart(poolID), hex.EncodeToString(sum[:])[:12])
}

func workerID(hostname, dataDir, poolID string) (string, string) {
	if configured := strings.TrimSpace(os.Getenv("WORKER_ID")); configured != "" {
		return configured, "env"
	}
	if fingerprint, source := dockerHostFingerprint(); fingerprint != "" {
		id := generatedWorkerID(poolID, fingerprint)
		_ = os.MkdirAll(dataDir, 0755)
		_ = ioutil.WriteFile(filepath.Join(dataDir, "worker-id"), []byte(id+"\n"), 0644)
		return id, source
	}
	marker := filepath.Join(dataDir, "worker-id")
	if data, err := ioutil.ReadFile(marker); err == nil {
		if saved := strings.TrimSpace(string(data)); saved != "" {
			return saved, "marker"
		}
	}
	id := fmt.Sprintf("%s-%s", safeWorkerPart(hostname), randomHex(4))
	_ = os.MkdirAll(dataDir, 0755)
	_ = ioutil.WriteFile(marker, []byte(id+"\n"), 0644)
	return id, "marker"
}

func configuredShards(count int) []string {
	raw := strings.TrimSpace(os.Getenv("WORKER_SHARDS"))
	if raw != "" {
		var shards []string
		for _, item := range strings.Split(raw, ",") {
			value := strings.TrimSpace(item)
			if value != "" {
				shards = append(shards, value)
			}
		}
		if len(shards) > 0 {
			return shards
		}
	}
	shards := make([]string, 0, count)
	for i := 0; i < count; i++ {
		shards = append(shards, fmt.Sprintf("%02d", i))
	}
	return shards
}

func randomHex(bytes int) string {
	data := make([]byte, bytes)
	if _, err := rand.Read(data); err == nil {
		return hex.EncodeToString(data)
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d:%s", os.Getpid(), url.QueryEscape(strconv.Itoa(os.Getppid())))))
	copy(data, sum[:bytes])
	return hex.EncodeToString(data)
}
