package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
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
	NgrokEnabled         bool
	NgrokAuthtoken       string
	NgrokBin             string
	NgrokRegion          string
}

func FromCompiledEnvironment() (Settings, error) {
	compiled := Environment
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "worker"
	}

	databaseURL := strings.TrimRight(strings.TrimSpace(compiled.FirebaseDatabaseURL), "/")
	if databaseURL == "" {
		return Settings{}, errors.New("FirebaseDatabaseURL is empty in environment.go")
	}
	if strings.TrimSpace(compiled.ServiceAccountJSON) == "" {
		return Settings{}, errors.New("ServiceAccountJSON is empty in environment.go")
	}
	if strings.TrimSpace(compiled.EncryptionKey) == "" {
		return Settings{}, errors.New("EncryptionKey is empty in environment.go")
	}

	dataDir := abs(defaultString(compiled.DataDir, "/app/data"))
	cloneDir := abs(defaultString(compiled.CloneDir, "/app/clones"))
	poolID := defaultString(compiled.PoolID, "default")
	workerID, source := workerID(hostname, dataDir, poolID, compiled.WorkerID, compiled.WorkerMachineID)
	shards := configuredShards(compiled.WorkerShards, minimum(compiled.QueueShardCount, 16, 1))

	return Settings{
		FirebaseDatabaseURL:  databaseURL,
		ServiceAccountJSON:   strings.TrimSpace(compiled.ServiceAccountJSON),
		WorkspaceID:          defaultString(compiled.WorkspaceID, "default"),
		PoolID:               poolID,
		WorkerID:             workerID,
		WorkerIdentitySource: source,
		WorkerLabel:          strings.TrimSpace(compiled.WorkerLabel),
		WorkerLocation:       strings.TrimSpace(compiled.WorkerLocation),
		Hostname:             hostname,
		Shards:               shards,
		MaxConcurrency:       minimum(compiled.MaxConcurrency, 2, 1),
		LeaseSeconds:         minimum(compiled.LeaseSeconds, 90, 30),
		PollSeconds:          minimum(compiled.PollSeconds, 5, 1),
		CloneDir:             cloneDir,
		DataDir:              dataDir,
		EncryptionKey:        compiled.EncryptionKey,
		NgrokEnabled:         compiled.NgrokEnabled || strings.TrimSpace(compiled.NgrokAuthtoken) != "",
		NgrokAuthtoken:       strings.TrimSpace(compiled.NgrokAuthtoken),
		NgrokBin:             defaultString(compiled.NgrokBin, "ngrok"),
		NgrokRegion:          strings.TrimSpace(compiled.NgrokRegion),
	}, nil
}

func (s Settings) WorkerLabelOrDefault() string {
	if strings.TrimSpace(s.WorkerLabel) != "" {
		return strings.TrimSpace(s.WorkerLabel)
	}
	return "Go"
}

func defaultString(value, fallback string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return fallback
}

func minimum(value, fallback, floor int) int {
	if value == 0 {
		value = fallback
	}
	if value < floor {
		return floor
	}
	return value
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

func dockerHostFingerprint(compiledMachineID string) (string, string) {
	if configured := strings.TrimSpace(compiledMachineID); configured != "" {
		return configured, "compiled"
	}
	output, err := exec.Command("docker", "info", "--format", "{{.ID}}|{{.Name}}").Output()
	if err == nil {
		value := strings.TrimSpace(string(output))
		if value != "" && value != "|" {
			return value, "docker"
		}
	}
	data, err := os.ReadFile("/etc/machine-id")
	if err == nil && strings.TrimSpace(string(data)) != "" {
		return strings.TrimSpace(string(data)), "machine-id"
	}
	return "", ""
}

func generatedWorkerID(poolID, fingerprint string) string {
	sum := sha256.Sum256([]byte(fingerprint))
	return fmt.Sprintf("worker-%s-%s", safeWorkerPart(poolID), hex.EncodeToString(sum[:])[:12])
}

func workerID(hostname, dataDir, poolID, compiledWorkerID, compiledMachineID string) (string, string) {
	if configured := strings.TrimSpace(compiledWorkerID); configured != "" {
		return configured, "compiled"
	}
	if fingerprint, source := dockerHostFingerprint(compiledMachineID); fingerprint != "" {
		id := generatedWorkerID(poolID, fingerprint)
		_ = os.MkdirAll(dataDir, 0755)
		_ = os.WriteFile(filepath.Join(dataDir, "worker-id"), []byte(id+"\n"), 0644)
		return id, source
	}
	marker := filepath.Join(dataDir, "worker-id")
	if data, err := os.ReadFile(marker); err == nil {
		if saved := strings.TrimSpace(string(data)); saved != "" {
			return saved, "marker"
		}
	}
	id := fmt.Sprintf("%s-%s", safeWorkerPart(hostname), randomHex(4))
	_ = os.MkdirAll(dataDir, 0755)
	_ = os.WriteFile(marker, []byte(id+"\n"), 0644)
	return id, "marker"
}

func configuredShards(compiled []string, count int) []string {
	shards := make([]string, 0, len(compiled))
	for _, item := range compiled {
		if value := strings.TrimSpace(item); value != "" {
			shards = append(shards, value)
		}
	}
	if len(shards) > 0 {
		return shards
	}
	shards = make([]string, 0, count)
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
