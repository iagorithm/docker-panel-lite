package core

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Summary map[string]interface{}

func DockerSummaryNow() Summary {
	versionRaw, versionErr := commandOutput(2*time.Second, "docker", "version", "--format", "{{json .Server}}")
	infoRaw, infoErr := commandOutput(2*time.Second, "docker", "info", "--format", "{{json .}}")
	if versionErr != nil || infoErr != nil {
		message := ""
		if versionErr != nil {
			message = versionErr.Error()
		} else {
			message = infoErr.Error()
		}
		return Summary{"available": false, "error": truncate(message, 240)}
	}
	var version map[string]interface{}
	var info map[string]interface{}
	_ = json.Unmarshal([]byte(versionRaw), &version)
	_ = json.Unmarshal([]byte(infoRaw), &info)
	return Summary{
		"available":         true,
		"serverVersion":     stringValue(version["Version"]),
		"apiVersion":        stringValue(version["APIVersion"]),
		"os":                stringValue(info["OperatingSystem"]),
		"architecture":      stringValue(info["Architecture"]),
		"containers":        intValue(info["Containers"]),
		"containersRunning": intValue(info["ContainersRunning"]),
		"images":            intValue(info["Images"]),
	}
}

type ContainerRecord map[string]interface{}

func ContainerInventory() (map[string]ContainerRecord, error) {
	raw, err := commandOutput(8*time.Second, "docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}
	result := map[string]ContainerRecord{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row map[string]interface{}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			continue
		}
		id := stringValue(firstValue(row, "ID", "Id", "ContainerID"))
		name := strings.TrimPrefix(stringValue(firstValue(row, "Names", "Name")), "/")
		if id == "" {
			id = name
		}
		if id == "" {
			continue
		}
		labels := parseLabels(stringValue(row["Labels"]))
		ports := parsePorts(stringValue(row["Ports"]))
		result[id] = ContainerRecord{
			"id":             id,
			"name":           name,
			"image":          stringValue(row["Image"]),
			"status":         normalizeContainerStatus(stringValue(row["State"]), stringValue(row["Status"])),
			"project":        labels["com.docker.compose.project"],
			"composeService": labels["com.docker.compose.service"],
			"ports":          ports,
			"updatedAt":      nowMillis(),
		}
	}
	return result, nil
}

func ContainerAction(action string, candidates []string) (string, *string, error) {
	containerID, name, err := resolveContainer(candidates)
	if err != nil {
		return "", nil, err
	}
	if IsWorkerContainerName(name) && (action == "container_stop" || action == "container_delete" || action == "container_exec") {
		return "", nil, fmt.Errorf("worker containers can only be restarted or inspected with logs")
	}
	switch action {
	case "container_start":
		if _, err := commandOutput(30*time.Second, "docker", "start", containerID); err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("Container '%s' started", nameOrID(name, containerID)), nil, nil
	case "container_stop":
		if _, err := commandOutput(35*time.Second, "docker", "stop", "-t", "20", containerID); err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("Container '%s' stopped", nameOrID(name, containerID)), nil, nil
	case "container_restart":
		if _, err := commandOutput(35*time.Second, "docker", "restart", "-t", "20", containerID); err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("Container '%s' restarted", nameOrID(name, containerID)), nil, nil
	case "container_delete":
		if _, err := commandOutput(35*time.Second, "docker", "rm", "-f", containerID); err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("Container '%s' deleted", nameOrID(name, containerID)), nil, nil
	case "container_logs":
		output, err := commandOutput(20*time.Second, "docker", "logs", "--tail", "100", containerID)
		if err != nil {
			return "", nil, err
		}
		tail := tailText(output, 100000)
		return fmt.Sprintf("Loaded logs for '%s'", nameOrID(name, containerID)), &tail, nil
	default:
		return "", nil, fmt.Errorf("unknown container action: %s", action)
	}
}

func WriteEnvFile(repoPath string, environment map[string]string) error {
	lines := make([]string, 0, len(environment))
	for key, value := range environment {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(key) {
			continue
		}
		lines = append(lines, formatEnvLine(key, value))
	}
	content := strings.Join(lines, "\n")
	if content != "" {
		content += "\n"
	}
	return os.WriteFile(filepath.Join(repoPath, ".env"), []byte(content), 0600)
}

func RunCompose(project string, repoPath string, composeFile string, environment map[string]string, down bool) (string, error) {
	if err := WriteEnvFile(repoPath, environment); err != nil {
		return "", err
	}
	args := []string{"compose", "-p", project, "-f", composeFile}
	if down {
		args = append(args, "down")
	} else {
		args = append(args, "up", "-d", "--build")
	}
	output, err := dockerOutput(900*time.Second, repoPath, environment, args...)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(output) != "" {
		return strings.TrimSpace(output), nil
	}
	if down {
		return "Stack stopped", nil
	}
	return "Stack deployed", nil
}

func RunDockerfile(project string, repoPath string, dockerfile string, environment map[string]string, ports []string) (string, error) {
	if err := WriteEnvFile(repoPath, environment); err != nil {
		return "", err
	}
	imageTag := project + ":managed"
	if _, err := dockerOutput(900*time.Second, repoPath, environment, "build", "-t", imageTag, "-f", dockerfile, "."); err != nil {
		return "", err
	}
	_, _ = dockerOutput(60*time.Second, repoPath, environment, "rm", "-f", project)
	args := []string{"run", "-d", "--name", project, "--env-file", filepath.Join(repoPath, ".env")}
	for _, port := range ports {
		if strings.TrimSpace(port) != "" {
			args = append(args, "-p", strings.TrimSpace(port))
		}
	}
	args = append(args, imageTag)
	output, err := dockerOutput(120*time.Second, repoPath, environment, args...)
	if err != nil {
		return "", err
	}
	containerID := strings.TrimSpace(output)
	if len(containerID) > 12 {
		containerID = containerID[:12]
	}
	return "Container " + containerID + " deployed", nil
}

func StopDockerfileContainer(project string) (string, error) {
	if _, err := dockerOutput(60*time.Second, "", nil, "rm", "-f", project); err != nil {
		return "", err
	}
	return "Container stopped", nil
}

func IsWorkerContainerName(name string) bool {
	normalized := normalizedName(name)
	if normalized == "worker" {
		return true
	}
	return regexp.MustCompile(`(^|[-_])worker([-_]1)?$`).MatchString(normalized)
}

func commandOutput(timeout time.Duration, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	timer := time.AfterFunc(timeout, func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})
	defer timer.Stop()
	output, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func dockerOutput(timeout time.Duration, workdir string, environment map[string]string, args ...string) (string, error) {
	cmd := exec.Command("docker", args...)
	if strings.TrimSpace(workdir) != "" {
		cmd.Dir = workdir
	}
	if len(environment) > 0 {
		env := os.Environ()
		for key, value := range environment {
			env = append(env, key+"="+value)
		}
		cmd.Env = env
	}
	timer := time.AfterFunc(timeout, func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})
	defer timer.Stop()
	output, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(output))
	if err != nil {
		return "", fmt.Errorf("%s", compactProcessError(text))
	}
	return text, nil
}

func compactProcessError(output string) string {
	text := strings.TrimSpace(output)
	if text == "" {
		return "docker command failed"
	}
	lines := []string{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
		if len(lines) >= 12 {
			break
		}
	}
	return truncate(strings.Join(lines, "\n"), 2000)
}

func formatEnvLine(key string, value string) string {
	text := strings.ReplaceAll(value, "\x00", "")
	if regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]*$`).MatchString(text) {
		return key + "=" + text
	}
	escaped := strings.ReplaceAll(text, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "'", "\\'")
	escaped = strings.ReplaceAll(escaped, "\r\n", "\n")
	escaped = strings.ReplaceAll(escaped, "\r", "\n")
	escaped = strings.ReplaceAll(escaped, "\n", "\\n")
	return key + "='" + escaped + "'"
}

func resolveContainer(candidates []string) (string, string, error) {
	var lastErr error
	for _, candidate := range uniqueNonEmpty(candidates) {
		raw, err := commandOutput(5*time.Second, "docker", "inspect", "--format", "{{.Id}}|{{.Name}}", candidate)
		if err != nil {
			lastErr = err
			continue
		}
		parts := strings.SplitN(strings.TrimSpace(raw), "|", 2)
		id := strings.TrimSpace(parts[0])
		name := ""
		if len(parts) > 1 {
			name = strings.TrimPrefix(strings.TrimSpace(parts[1]), "/")
		}
		if id != "" {
			return id, name, nil
		}
	}
	if lastErr != nil {
		return "", "", lastErr
	}
	return "", "", fmt.Errorf("container reference is missing")
}

func uniqueNonEmpty(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		text := strings.TrimSpace(value)
		if text == "" || seen[text] {
			continue
		}
		seen[text] = true
		result = append(result, text)
	}
	return result
}

func firstValue(row map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if value, ok := row[key]; ok {
			return value
		}
	}
	return nil
}

func parseLabels(raw string) map[string]string {
	result := map[string]string{}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" || !strings.Contains(item, "=") {
			continue
		}
		parts := strings.SplitN(item, "=", 2)
		result[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}
	return result
}

func parsePorts(raw string) []string {
	ports := []string{}
	for _, item := range strings.Split(raw, ",") {
		text := strings.TrimSpace(item)
		if text != "" {
			ports = append(ports, text)
		}
	}
	return ports
}

func normalizeContainerStatus(state string, status string) string {
	text := strings.ToLower(strings.TrimSpace(state))
	if text != "" {
		return text
	}
	status = strings.ToLower(strings.TrimSpace(status))
	if strings.HasPrefix(status, "up ") {
		return "running"
	}
	if strings.HasPrefix(status, "exited") {
		return "exited"
	}
	return status
}

func normalizedName(value string) string {
	builder := strings.Builder{}
	for _, char := range strings.ToLower(value) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func nameOrID(name string, id string) string {
	if strings.TrimSpace(name) != "" {
		return strings.TrimSpace(name)
	}
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func tailText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[len(value)-limit:]
}

func nowMillis() int64 {
	return time.Now().UnixNano() / int64(time.Millisecond)
}

func stringValue(value interface{}) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(toString(value))
}

func intValue(value interface{}) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		parsed, _ := strconv.Atoi(typed)
		return parsed
	default:
		return 0
	}
}

func toString(value interface{}) string {
	switch typed := value.(type) {
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
