package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"docker-panel-lite-worker-go/worker/core"
)

type Result struct {
	Message string
	Updates map[string]interface{}
	Command *core.CommandResult
}

func publicURLsMessage(value interface{}) string {
	urls := mapValue(value)
	services := make([]string, 0, len(urls))
	for service := range urls {
		services = append(services, service)
	}
	sort.Strings(services)
	parts := make([]string, 0, len(services))
	for _, service := range services {
		if url := stringValue(urls[service]); url != "" {
			parts = append(parts, fmt.Sprintf("%s: %s", service, url))
		}
	}
	message := fmt.Sprintf("Public URLs ready: %d", len(urls))
	if len(parts) > 0 {
		message += ". " + strings.Join(parts, ", ")
	}
	return message
}

func executeContainerTunnel(job map[string]interface{}, settings Settings) (string, map[string]interface{}, error) {
	name, target, err := core.ContainerTunnelTarget(
		[]string{stringValue(job["containerRef"]), stringValue(job["containerId"])},
		intValueDefault(job["internalPort"], 3000),
		settings.Hostname,
	)
	if err != nil {
		return "", nil, err
	}
	tunnelKey, err := core.SafeName("container-" + settings.WorkerID + "-" + name)
	if err != nil {
		return "", nil, err
	}
	service := core.NewNgrokService(settings.DataDir, settings.NgrokEnabled, settings.NgrokAuthtoken, settings.NgrokBin, settings.NgrokRegion)
	if boolValue(job["tunnelReset"]) {
		service.Stop(tunnelKey)
	}
	tunnel, err := service.Start(tunnelKey, target, "")
	if err != nil {
		return "", nil, err
	}
	updates := map[string]interface{}{
		"publicUrl":               tunnel.URL,
		"publicUrls":              map[string]interface{}{"container": tunnel.URL},
		"publicTunnelStatus":      "online",
		"publicTunnelTarget":      tunnel.Target,
		"publicTunnelWorkerId":    settings.WorkerID,
		"publicTunnelWorkerLabel": settings.WorkerLabelOrDefault(),
		"publicTunnelUpdatedAt":   nowMillis(),
	}
	return fmt.Sprintf("Public URL ready for local container '%s': %s", name, tunnel.URL), updates, nil
}

func Execute(ctx context.Context, client *Client, job map[string]interface{}, repository map[string]interface{}, settings Settings) (Result, error) {
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
	case "sync", "read_compose", "read_dockerfile":
		path, err := syncRepository(ctx, client, repository, workspaceID, settings)
		if err != nil {
			return Result{}, err
		}
		updates := map[string]interface{}{}
		mode := stringValue(repository["mode"])
		if action == "read_compose" && mode != "compose" {
			return Result{}, fmt.Errorf("project is not configured for Docker Compose")
		}
		if action == "read_dockerfile" && mode != "dockerfile" {
			return Result{}, fmt.Errorf("project is not configured for Dockerfile")
		}
		if mode == "compose" && action != "read_dockerfile" {
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
		} else if mode == "dockerfile" && action == "read_dockerfile" {
			dockerfilePath, err := repositoryFile(path, stringValue(repository["dockerfile"]), "Dockerfile", "Dockerfile", true)
			if err != nil {
				return Result{}, err
			}
			if info, err := os.Stat(dockerfilePath); err != nil {
				return Result{}, err
			} else if info.Size() > 1_000_000 {
				return Result{}, fmt.Errorf("Dockerfile is larger than 1 MB")
			}
			content, err := os.ReadFile(dockerfilePath)
			if err != nil {
				return Result{}, err
			}
			updates["dockerfileContent"] = string(content)
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
			message, err := core.RunCompose(project, path, composePath, environment, true, settings.DataDir, stringValue(repository["service"]))
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
	case "tunnel_stop":
		updates, err := stopPublicTunnel(repository, settings)
		if err != nil {
			return Result{}, err
		}
		return Result{Message: "Public URL closed", Updates: updates}, nil
	case "tunnel_start":
		updates, err := startPublicTunnel(ctx, client, repository, workspaceID, settings, stringValue(job["tunnelService"]), boolValue(job["tunnelReset"]))
		if err != nil {
			return Result{}, err
		}
		return Result{Message: publicURLsMessage(updates["publicUrls"]), Updates: updates}, nil
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
			message, err := core.RunCompose(project, path, composePath, environment, false, settings.DataDir, stringValue(repository["service"]))
			if err != nil {
				return Result{}, err
			}
			updates := map[string]interface{}{}
			if repositoryPublicTunnelEnabled(repository) {
				tunnelUpdates, err := startPublicTunnel(ctx, client, repository, workspaceID, settings, "", false)
				if err != nil {
					return Result{}, err
				}
				updates = tunnelUpdates
				if len(mapValue(updates["publicUrls"])) > 0 {
					message = fmt.Sprintf("%s. %s", message, publicURLsMessage(updates["publicUrls"]))
				}
			}
			return Result{Message: message, Updates: updates}, nil
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
		updates := map[string]interface{}{}
		if repositoryPublicTunnelEnabled(repository) {
			tunnelUpdates, err := startPublicTunnel(ctx, client, repository, workspaceID, settings, "", false)
			if err != nil {
				return Result{}, err
			}
			updates = tunnelUpdates
			if len(mapValue(updates["publicUrls"])) > 0 {
				message = fmt.Sprintf("%s. %s", message, publicURLsMessage(updates["publicUrls"]))
			}
		}
		return Result{Message: message, Updates: updates}, nil
	default:
		return Result{}, fmt.Errorf("unknown repository action: %s", action)
	}
}

func ExecuteWorkerCommand(ctx context.Context, client *Client, job map[string]interface{}, repository map[string]interface{}, settings Settings) (Result, error) {
	workspaceID := stringValue(job["workspaceId"])
	command := stringValue(job["command"])
	if command == "" {
		return Result{}, fmt.Errorf("command is empty")
	}
	workdir := settings.CloneDir
	environment := map[string]string{}
	if repository != nil && len(repository) > 0 {
		path, err := repoPath(settings, repository)
		if err != nil {
			return Result{}, err
		}
		workdir = path
		loaded, err := loadEnvironment(ctx, client, repository, workspaceID)
		if err != nil {
			return Result{}, err
		}
		environment = loaded
	}
	info, err := os.Stat(workdir)
	if err != nil || !info.IsDir() {
		return Result{}, fmt.Errorf("working directory not found: %s. Sync or deploy the repository first", workdir)
	}
	result, err := core.RunWorkerCommandContext(ctx, command, workdir, environment, intValue(job["timeoutSeconds"]))
	if err != nil {
		return Result{}, err
	}
	return Result{Message: result.Message, Updates: map[string]interface{}{}, Command: &result}, nil
}

func loadEnvironment(ctx context.Context, client *Client, repository map[string]interface{}, workspaceID string) (map[string]string, error) {
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
	for _, item := range regexp.MustCompile(`[\s,]+`).Split(value, -1) {
		text := strings.TrimSpace(item)
		if text != "" {
			result = append(result, text)
		}
	}
	return result
}

func stoppedTunnelUpdates(settings Settings) map[string]interface{} {
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

func stopPublicTunnel(repository map[string]interface{}, settings Settings) (map[string]interface{}, error) {
	project, err := projectName(repository)
	if err != nil {
		return nil, err
	}
	core.NewNgrokService(settings.DataDir, settings.NgrokEnabled, settings.NgrokAuthtoken, settings.NgrokBin, settings.NgrokRegion).StopPrefix(project)
	return stoppedTunnelUpdates(settings), nil
}

func startPublicTunnel(ctx context.Context, client *Client, repository map[string]interface{}, workspaceID string, settings Settings, onlyService string, reset bool) (map[string]interface{}, error) {
	project, err := projectName(repository)
	if err != nil {
		return nil, err
	}
	targets, err := core.PublicTunnelTargets(project, stringValue(repository["mode"]), strings.TrimSpace(onlyService), intValueDefault(repository["internalPort"], 3000), repositoryPublicTunnelPorts(repository), settings.Hostname)
	if err != nil {
		return nil, err
	}
	authtoken, err := repositoryNgrokAuthtoken(ctx, client, repository, workspaceID, settings)
	if err != nil {
		return nil, err
	}
	service := core.NewNgrokService(settings.DataDir, settings.NgrokEnabled || authtoken != "", authtoken, settings.NgrokBin, settings.NgrokRegion)
	serviceDomains := repositoryStringMap(firstPresent(repository, "publicTunnelDomains", "publicDomains", "ngrokDomains"))
	singleDomain := stringValue(firstPresent(repository, "publicTunnelDomain", "publicDomain", "ngrokDomain"))
	publicUrls := map[string]interface{}{}
	publicTunnels := map[string]interface{}{}
	if strings.TrimSpace(onlyService) != "" {
		for key, value := range mapValue(repository["publicUrls"]) {
			publicUrls[key] = value
		}
		for key, value := range mapValue(repository["publicTunnels"]) {
			publicTunnels[key] = value
		}
	}
	for serviceName, target := range targets {
		tunnelKey := project
		if stringValue(repository["mode"]) == "compose" {
			safeService, err := core.SafeName(serviceName)
			if err != nil {
				return nil, err
			}
			tunnelKey = project + "--" + safeService
		}
		if reset {
			service.Stop(tunnelKey)
			if stringValue(repository["mode"]) == "compose" {
				service.Stop(project)
			}
		}
		domain := serviceDomains[serviceName]
		if len(targets) == 1 && domain == "" {
			domain = singleDomain
		}
		tunnel, err := service.Start(tunnelKey, target, domain)
		if err != nil {
			return nil, err
		}
		publicUrls[serviceName] = tunnel.URL
		publicTunnels[serviceName] = map[string]interface{}{
			"url":         tunnel.URL,
			"target":      tunnel.Target,
			"domain":      tunnel.Domain,
			"pid":         tunnel.PID,
			"workerId":    settings.WorkerID,
			"workerLabel": settings.WorkerLabelOrDefault(),
			"updatedAt":   nowMillis(),
		}
	}
	firstService := stringValue(repository["service"])
	if _, ok := publicUrls[firstService]; !ok {
		for serviceName := range publicUrls {
			firstService = serviceName
			break
		}
	}
	firstTunnel, _ := publicTunnels[firstService].(map[string]interface{})
	return map[string]interface{}{
		"publicUrl":               stringValue(publicUrls[firstService]),
		"publicUrls":              publicUrls,
		"publicTunnels":           publicTunnels,
		"publicTunnelStatus":      "online",
		"publicTunnelTarget":      stringValue(firstTunnel["target"]),
		"publicTunnelWorkerId":    settings.WorkerID,
		"publicTunnelWorkerLabel": settings.WorkerLabelOrDefault(),
		"publicTunnelUpdatedAt":   nowMillis(),
	}, nil
}

func repositoryNgrokAuthtoken(ctx context.Context, client *Client, repository map[string]interface{}, workspaceID string, settings Settings) (string, error) {
	repositoryID := stringValue(repository["id"])
	if repositoryID == "" {
		repositoryID = stringValue(repository["alias"])
	}
	if repositoryID != "" {
		encrypted := map[string]interface{}{}
		_ = client.Get(ctx, fmt.Sprintf("secrets/ngrok/%s/%s", workspaceID, repositoryID), &encrypted)
		if len(encrypted) > 0 {
			return DecryptSecret(encrypted, settings.EncryptionKey)
		}
	}
	return stringValue(firstPresent(repository, "ngrokAuthtoken", "ngrokToken", "ngrokApiKey")), nil
}

func syncRepository(ctx context.Context, client *Client, repository map[string]interface{}, workspaceID string, settings Settings) (string, error) {
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

func credential(ctx context.Context, client *Client, workspaceID string, credentialID string, settings Settings) (string, error) {
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
	return DecryptSecret(encrypted, settings.EncryptionKey)
}

func repoPath(settings Settings, repository map[string]interface{}) (string, error) {
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

func repositoryPublicTunnelEnabled(repository map[string]interface{}) bool {
	return boolValue(repository["publicTunnelEnabled"]) || boolValue(repository["exposePublic"]) || boolValue(repository["ngrokEnabled"])
}

func repositoryPublicTunnelPorts(repository map[string]interface{}) map[string]int {
	result := map[string]int{}
	for key, value := range repositoryStringMap(firstPresent(repository, "publicTunnelPorts", "publicPorts", "ngrokPorts")) {
		port := intValue(value)
		if port >= 1 && port <= 65535 {
			result[key] = port
		}
	}
	return result
}

func repositoryStringMap(value interface{}) map[string]string {
	result := map[string]string{}
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, item := range typed {
			if strings.TrimSpace(key) != "" && stringValue(item) != "" {
				result[strings.TrimSpace(key)] = stringValue(item)
			}
		}
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return result
		}
		if strings.HasPrefix(text, "{") {
			var parsed map[string]interface{}
			if err := json.Unmarshal([]byte(regexp.MustCompile(`,\s*([}\]])`).ReplaceAllString(text, "$1")), &parsed); err == nil {
				return repositoryStringMap(parsed)
			}
			return result
		}
		for _, item := range regexp.MustCompile(`[\n,]+`).Split(text, -1) {
			if strings.Contains(item, "=") {
				parts := strings.SplitN(item, "=", 2)
				key := strings.TrimSpace(parts[0])
				value := strings.TrimSpace(parts[1])
				if key != "" && value != "" {
					result[key] = value
				}
			}
		}
	}
	return result
}

func firstPresent(values map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if value := values[key]; value != nil && stringValue(value) != "" {
			return value
		}
	}
	return nil
}

func mapValue(value interface{}) map[string]interface{} {
	if typed, ok := value.(map[string]interface{}); ok {
		return typed
	}
	return map[string]interface{}{}
}

func boolValue(value interface{}) bool {
	if typed, ok := value.(bool); ok {
		return typed
	}
	text := strings.ToLower(stringValue(value))
	return text == "1" || text == "true" || text == "yes" || text == "on" || text == "enabled"
}

func intValue(value interface{}) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		return parsed
	default:
		return 0
	}
}

func intValueDefault(value interface{}, fallback int) int {
	parsed := intValue(value)
	if parsed == 0 {
		return fallback
	}
	return parsed
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
