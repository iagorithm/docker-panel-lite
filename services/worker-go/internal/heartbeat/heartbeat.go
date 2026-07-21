package heartbeat

import (
	"context"
	"os"
	"runtime"
	"time"

	"docker-panel-lite-worker-go/internal/config"
	"docker-panel-lite-worker-go/internal/docker"
	"docker-panel-lite-worker-go/internal/firebase"
)

type Agent struct {
	client          *firebase.Client
	settings        config.Settings
	workerTokenHash string
	startedAt       int64
}

func New(client *firebase.Client, settings config.Settings, workerTokenHash string) *Agent {
	return &Agent{
		client:          client,
		settings:        settings,
		workerTokenHash: workerTokenHash,
		startedAt:       nowMillis(),
	}
}

func (a *Agent) Send(ctx context.Context, status string, activeJobs int) error {
	path := "workspaces/" + a.settings.WorkspaceID + "/agents/" + a.settings.WorkerID
	existing := map[string]interface{}{}
	_ = a.client.Get(ctx, path, &existing)

	sharing := stringValue(existing["sharing"])
	if sharing != "private" && sharing != "shared" && sharing != "public" {
		sharing = "private"
	}
	payload := map[string]interface{}{
		"id":               a.settings.WorkerID,
		"runtime":          "go",
		"runtimeVersion":   runtime.Version(),
		"workerVersion":    "dev",
		"features":         []string{"heartbeat", "claim", "docker-summary"},
		"identitySource":   a.settings.WorkerIdentitySource,
		"label":            a.settings.WorkerLabelOrDefault(),
		"hostname":         a.settings.Hostname,
		"location":         a.settings.WorkerLocation,
		"poolId":           a.settings.PoolID,
		"status":           status,
		"activeJobs":       activeJobs,
		"maxConcurrency":   a.settings.MaxConcurrency,
		"shards":           a.settings.Shards,
		"lastHeartbeat":    nowMillis(),
		"startedAt":        a.startedAt,
		"pid":              os.Getpid(),
		"goVersion":        runtime.Version(),
		"platform":         runtime.GOOS + "/" + runtime.GOARCH,
		"system":           runtime.GOOS,
		"machine":          runtime.GOARCH,
		"executable":       executable(),
		"cloneDir":         a.settings.CloneDir,
		"dataDir":          a.settings.DataDir,
		"traefikEnabled":   a.settings.TraefikEnabled,
		"traefikNetwork":   a.settings.TraefikNetwork,
		"ngrokEnabled":     a.settings.NgrokEnabled,
		"ngrokRegion":      a.settings.NgrokRegion,
		"leaseSeconds":     a.settings.LeaseSeconds,
		"pollSeconds":      a.settings.PollSeconds,
		"docker":           docker.SummaryNow(),
		"sharing":          sharing,
		"shared":           sharing == "shared" || sharing == "public",
		"public":           sharing == "public",
		"sharingUpdatedAt": existing["sharingUpdatedAt"],
		"sharingUpdatedBy": stringValue(existing["sharingUpdatedBy"]),
		"workerTokenHash":  a.workerTokenHash,
		"claimedAt":        existing["claimedAt"],
		"claimedBy":        stringValue(existing["claimedBy"]),
		"ownerUid":         stringValue(existing["ownerUid"]),
		"ownerEmail":       stringValue(existing["ownerEmail"]),
		"sharedEmails":     existingSharedEmails(existing["sharedEmails"]),
	}
	return a.client.Put(ctx, path, payload)
}

func nowMillis() int64 {
	return time.Now().UnixNano() / int64(time.Millisecond)
}

func executable() string {
	value, err := os.Executable()
	if err != nil {
		return ""
	}
	return value
}

func stringValue(value interface{}) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func existingSharedEmails(value interface{}) interface{} {
	if value == nil {
		return []string{}
	}
	return value
}
