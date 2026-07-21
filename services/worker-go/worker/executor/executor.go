package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"docker-panel-lite-worker-go/worker/config"
	"docker-panel-lite-worker-go/worker/core"
	"docker-panel-lite-worker-go/worker/firebase_runtime"
	"docker-panel-lite-worker-go/worker/secrets"
)

type Result struct {
	Message string
	Updates map[string]interface{}
}

func Execute(ctx context.Context, client *firebase_runtime.Client, job map[string]interface{}, repository map[string]interface{}, settings config.Settings) (Result, error) {
	action := stringValue(job["action"])
	workspaceID := stringValue(job["workspaceId"])
	switch action {
	case "discover_branches":
		token, err := credential(ctx, client, workspaceID, stringValue(repository["credentialId"]), settings)
		if err != nil {
			return Result{}, err
		}
		branches, err := core.ListRemoteBranches(stringValue(repository["url"]), token)
		if err != nil {
			return Result{}, err
		}
		return Result{
			Message: fmt.Sprintf("Found %d branches", len(branches)),
			Updates: map[string]interface{}{
				"availableBranches": branches,
				"branchesUpdatedAt": nowMillis(),
			},
		}, nil
	case "sync", "read_compose":
		path, err := syncRepository(ctx, client, repository, workspaceID, settings)
		if err != nil {
			return Result{}, err
		}
		updates := map[string]interface{}{}
		if stringValue(repository["mode"]) == "compose" {
			composePath, err := repositoryFile(path, stringValue(repository["composeFile"]), "compose.yml", "Compose file", true)
			if err != nil {
				return Result{}, err
			}
			if info, err := os.Stat(composePath); err != nil {
				return Result{}, err
			} else if info.Size() > 1_000_000 {
				return Result{}, fmt.Errorf("compose file is larger than 1 MB")
			}
			content, err := os.ReadFile(composePath)
			if err != nil {
				return Result{}, err
			}
			updates["composeContent"] = string(content)
		}
		return Result{Message: "Repository synchronized", Updates: updates}, nil
	case "stop":
		path, err := repoPath(settings, repository)
		if err != nil {
			return Result{}, err
		}
		project, err := projectName(repository)
		if err != nil {
			return Result{}, err
		}
		environment, err := loadEnvironment(ctx, client, repository, workspaceID)
		if err != nil {
			return Result{}, err
		}
		if stringValue(repository["mode"]) == "compose" {
			composePath, err := repositoryFile(path, stringValue(repository["composeFile"]), "compose.yml", "Compose file", true)
			if err != nil {
				return Result{}, err
			}
			message, err := core.RunCompose(project, path, composePath, environment, true)
			if err != nil {
				return Result{}, err
			}
			return Result{Message: message, Updates: stoppedTunnelUpdates(settings)}, nil
		}
		message, err := core.StopDockerfileContainer(project)
		if err != nil {
			return Result{}, err
		}
		return Result{Message: message, Updates: stoppedTunnelUpdates(settings)}, nil
	case "deploy", "build":
		path, err := syncRepository(ctx, client, repository, workspaceID, settings)
		if err != nil {
			return Result{}, err
		}
		project, err := projectName(repository)
		if err != nil {
			return Result{}, err
		}
		environment, err := loadEnvironment(ctx, client, repository, workspaceID)
		if err != nil {
			return Result{}, err
		}
		if stringValue(repository["mode"]) == "compose" {
			composePath, err := repositoryFile(path, stringValue(repository["composeFile"]), "compose.yml", "Compose file", true)
			if err != nil {
				return Result{}, err
			}
			message, err := core.RunCompose(project, path, composePath, environment, false)
			if err != nil {
				return Result{}, err
			}
			return Result{Message: message, Updates: map[string]interface{}{}}, nil
		}
		dockerfilePath, err := repositoryFile(path, stringValue(repository["dockerfile"]), "Dockerfile", "Dockerfile", true)
		if err != nil {
			return Result{}, err
		}
		relativeDockerfile, err := filepath.Rel(path, dockerfilePath)
		if err != nil {
			return Result{}, err
		}
		message, err := core.RunDockerfile(project, path, relativeDockerfile, environment, parsePorts(stringValue(repository["ports"])))
		if err != nil {
			return Result{}, err
		}
		return Result{Message: message, Updates: map[string]interface{}{}}, nil
	case "tunnel_start", "tunnel_stop":
		return Result{}, fmt.Errorf("Go worker does not implement tunnel action yet: %s", action)
	default:
		return Result{}, fmt.Errorf("unknown repository action: %s", action)
	}
}

func loadEnvironment(ctx context.Context, client *firebase_runtime.Client, repository map[string]interface{}, workspaceID string) (map[string]string, error) {
	environment := map[string]string{}
	workspaceEnvironment := interface{}(nil)
	_ = client.Get(ctx, fmt.Sprintf("workspaces/%s/environment", workspaceID), &workspaceEnvironment)
	mergeEnvironment(environment, workspaceEnvironment)
	repositoryID := stringValue(repository["id"])
	if repositoryID == "" {
		repositoryID = stringValue(repository["alias"])
	}
	if repositoryID != "" {
		var value interface{}
		_ = client.Get(ctx, fmt.Sprintf("workspaces/%s/repositories/%s/env_vars", workspaceID, repositoryID), &value)
		mergeEnvironment(environment, value)
		value = nil
		_ = client.Get(ctx, fmt.Sprintf("workspaces/%s/repositories/%s/env", workspaceID, repositoryID), &value)
		mergeEnvironment(environment, value)
		value = nil
		_ = client.Get(ctx, fmt.Sprintf("workspaces/%s/repositories/%s/environment", workspaceID, repositoryID), &value)
		mergeEnvironment(environment, value)
	}
	mergeEnvironment(environment, repository["env_vars"])
	mergeEnvironment(environment, repository["env"])
	mergeEnvironment(environment, repository["environment"])
	return environment, nil
}

func mergeEnvironment(target map[string]string, value interface{}) {
	for key, item := range normalizeEnvironment(value) {
		if regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(key) {
			target[key] = item
		}
	}
}

func normalizeEnvironment(value interface{}) map[string]string {
	result := map[string]string{}
	switch typed := value.(type) {
	case nil:
		return result
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return result
		}
		if strings.HasPrefix(text, "{") {
			var parsed map[string]interface{}
			if err := json.Unmarshal([]byte(text), &parsed); err == nil {
				return normalizeEnvironment(parsed)
			}
		}
		for _, line := range strings.Split(text, "\n") {
			item := strings.TrimSpace(line)
			if item == "" || strings.HasPrefix(item, "#") || !strings.Contains(item, "=") {
				continue
			}
			parts := strings.SplitN(item, "=", 2)
			result[strings.TrimSpace(strings.TrimPrefix(parts[0], "export "))] = normalizeEnvironmentValue(strings.TrimSpace(parts[1]))
		}
	case map[string]interface{}:
		for key, item := range typed {
			if nested, ok := item.(map[string]interface{}); ok {
				if value, exists := nested["value"]; exists {
					item = value
				} else if value, exists := nested["Value"]; exists {
					item = value
				}
			}
			result[strings.TrimSpace(key)] = normalizeEnvironmentValue(item)
		}
	case []interface{}:
		for _, item := range typed {
			for key, value := range normalizeEnvironment(item) {
				result[key] = value
			}
		}
	}
	return result
}

func normalizeEnvironmentValue(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		text := strings.TrimSpace(typed)
		if len(text) >= 2 && ((text[0] == '"' && text[len(text)-1] == '"') || (text[0] == '\'' && text[len(text)-1] == '\'')) {
			text = text[1 : len(text)-1]
			text = strings.ReplaceAll(text, `\n`, "\n")
			text = strings.ReplaceAll(text, `\"`, `"`)
		}
		return strings.ReplaceAll(text, "\x00", "")
	case map[string]interface{}, []interface{}:
		payload, _ := json.Marshal(typed)
		return string(payload)
	default:
		return strings.ReplaceAll(fmt.Sprint(typed), "\x00", "")
	}
}

func projectName(repository map[string]interface{}) (string, error) {
	alias := stringValue(repository["alias"])
	if alias == "" {
		alias = stringValue(repository["id"])
	}
	return core.SafeName(alias)
}

func parsePorts(value string) []string {
	result := []string{}
	for _, item := range regexp.MustCompile(`[\n,]+`).Split(value, -1) {
		text := strings.TrimSpace(item)
		if text != "" {
			result = append(result, text)
		}
	}
	return result
}

func stoppedTunnelUpdates(settings config.Settings) map[string]interface{} {
	return map[string]interface{}{
		"publicUrl":               "",
		"publicUrls":              map[string]interface{}{},
		"publicTunnels":           map[string]interface{}{},
		"publicTunnelStatus":      "stopped",
		"publicTunnelTarget":      "",
		"publicTunnelWorkerId":    "",
		"publicTunnelWorkerLabel": "",
		"publicTunnelUpdatedAt":   nowMillis(),
	}
}

func syncRepository(ctx context.Context, client *firebase_runtime.Client, repository map[string]interface{}, workspaceID string, settings config.Settings) (string, error) {
	path, err := repoPath(settings, repository)
	if err != nil {
		return "", err
	}
	token, err := credential(ctx, client, workspaceID, stringValue(repository["credentialId"]), settings)
	if err != nil {
		return "", err
	}
	if _, err := core.SyncRepo(stringValue(repository["url"]), path, token, stringValue(repository["branch"])); err != nil {
		return "", err
	}
	return path, nil
}

func credential(ctx context.Context, client *firebase_runtime.Client, workspaceID string, credentialID string, settings config.Settings) (string, error) {
	if strings.TrimSpace(credentialID) == "" {
		return "", nil
	}
	encrypted := map[string]interface{}{}
	if err := client.Get(ctx, fmt.Sprintf("secrets/credentials/%s/%s", workspaceID, credentialID), &encrypted); err != nil {
		return "", err
	}
	if len(encrypted) == 0 {
		return "", fmt.Errorf("credential '%s' does not exist", credentialID)
	}
	return secrets.DecryptSecret(encrypted, settings.EncryptionKey)
}

func repoPath(settings config.Settings, repository map[string]interface{}) (string, error) {
	alias := stringValue(repository["alias"])
	if alias == "" {
		alias = stringValue(repository["id"])
	}
	project, err := core.SafeName(alias)
	if err != nil {
		return "", err
	}
	base, err := filepath.Abs(settings.CloneDir)
	if err != nil {
		return "", err
	}
	path, err := filepath.Abs(filepath.Join(base, project))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("repository path escapes the configured clone directory")
	}
	return path, nil
}

func repositoryFile(repoPath string, rawValue string, fallback string, label string, mustExist bool) (string, error) {
	value := strings.TrimSpace(rawValue)
	if value == "" {
		value = fallback
	}
	if !core.ValidateRelativeFilePath(value) {
		return "", fmt.Errorf("%s must be a file path relative to the repository root", label)
	}
	resolved, err := filepath.Abs(filepath.Join(repoPath, value))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(repoPath, resolved)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("%s resolves outside the repository", label)
	}
	if mustExist {
		info, err := os.Stat(resolved)
		if err != nil || info.IsDir() {
			return "", fmt.Errorf("%s not found: %s", label, value)
		}
	}
	return resolved, nil
}

func stringValue(value interface{}) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func nowMillis() int64 {
	return time.Now().UnixNano() / int64(time.Millisecond)
}
