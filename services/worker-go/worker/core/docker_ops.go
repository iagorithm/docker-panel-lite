package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
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

type CommandResult struct {
	Message  string
	Output   string
	ExitCode int
}

func ContainerAction(action string, candidates []string) (string, *string, error) {
	containerID, name, err := resolveContainer(candidates)
	if err != nil {
		return "", nil, err
	}
	if IsWorkerContainer(containerID, name) && (action == "container_stop" || action == "container_delete" || action == "container_exec") {
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
		output, err := commandOutput(20*time.Second, "docker", "logs", "--tail", "1000", containerID)
		if err != nil {
			return "", nil, err
		}
		tail := tailText(output, 500000)
		return fmt.Sprintf("Loaded logs for '%s'", nameOrID(name, containerID)), &tail, nil
	default:
		return "", nil, fmt.Errorf("unknown container action: %s", action)
	}
}

func ContainerExec(candidates []string, command string, timeoutSeconds int) (CommandResult, error) {
	return ContainerExecContext(context.Background(), candidates, command, timeoutSeconds)
}

func ContainerExecContext(ctx context.Context, candidates []string, command string, timeoutSeconds int) (CommandResult, error) {
	containerID, name, err := resolveContainer(candidates)
	if err != nil {
		return CommandResult{}, err
	}
	if IsWorkerContainer(containerID, name) {
		return CommandResult{}, fmt.Errorf("worker containers can only be restarted or inspected with logs")
	}
	shellCommand, err := containerExecShellCommand(command)
	if err != nil {
		return CommandResult{}, err
	}
	timeout := boundedTimeout(timeoutSeconds)
	output, exitCode, timedOut, cancelled := dockerOutputWithExitContext(ctx, timeout, "", nil, "exec", containerID, "/bin/sh", "-lc", shellCommand)
	if cancelled {
		return CommandResult{Message: "Container command cancelled", Output: tailText(output, 120000), ExitCode: 130}, context.Canceled
	}
	if timedOut {
		message := fmt.Sprintf("Command timed out after %ds", int(timeout/time.Second))
		if strings.TrimSpace(output) == "" {
			output = message
		}
		return CommandResult{Message: message, Output: tailText(output, 120000), ExitCode: 124}, nil
	}
	if exitCode != 0 {
		message := fmt.Sprintf("Container command exited with code %d", exitCode)
		if strings.TrimSpace(output) == "" {
			output = message
		}
		return CommandResult{Message: message, Output: tailText(output, 120000), ExitCode: exitCode}, nil
	}
	if strings.TrimSpace(output) == "" {
		output = "Command completed with no output."
	}
	return CommandResult{Message: fmt.Sprintf("Command completed inside '%s'", nameOrID(name, containerID)), Output: tailText(output, 120000), ExitCode: 0}, nil
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

func RunCompose(project string, repoPath string, composeFile string, environment map[string]string, down bool, dataDir string, service string) (string, error) {
	if err := WriteEnvFile(repoPath, environment); err != nil {
		return "", err
	}
	args := []string{"compose", "-p", project, "-f", composeFile}
	if len(environment) > 0 {
		override, err := WriteComposeOverride(project, dataDir, environment, composeFile, service)
		if err != nil {
			return "", err
		}
		if override != "" {
			args = append(args, "-f", override)
		}
	}
	if !down {
		if err := validateComposeDeploymentPorts(project, repoPath, environment, args); err != nil {
			return "", err
		}
	}
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
	bindings, err := configuredPortBindings(ports)
	if err != nil {
		return "", err
	}
	if err := validateDeploymentPorts(project, bindings); err != nil {
		return "", err
	}
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

type portBinding struct {
	Port     int
	Protocol string
}

func configuredPortBindings(values []string) (map[portBinding]bool, error) {
	bindings := map[portBinding]bool{}
	pattern := regexp.MustCompile(`^(\d+):(\d+)(?:/(tcp|udp))?$`)
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		match := pattern.FindStringSubmatch(strings.ToLower(value))
		if match == nil {
			return nil, fmt.Errorf("invalid port mapping '%s'. Use host:container, for example 8080:80", value)
		}
		hostPort, _ := strconv.Atoi(match[1])
		containerPort, _ := strconv.Atoi(match[2])
		if hostPort < 1 || hostPort > 65535 || containerPort < 1 || containerPort > 65535 {
			return nil, fmt.Errorf("invalid port mapping '%s'. Ports must be between 1 and 65535", value)
		}
		protocol := match[3]
		if protocol == "" {
			protocol = "tcp"
		}
		binding := portBinding{Port: hostPort, Protocol: protocol}
		if bindings[binding] {
			return nil, fmt.Errorf("port %d/%s is declared more than once", hostPort, protocol)
		}
		bindings[binding] = true
	}
	return bindings, nil
}

func validateComposeDeploymentPorts(project, repoPath string, environment map[string]string, composeArgs []string) error {
	args := append(append([]string{}, composeArgs...), "config", "--format", "json")
	raw, err := dockerOutput(60*time.Second, repoPath, environment, args...)
	if err != nil {
		return err
	}
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return fmt.Errorf("Docker Compose returned invalid JSON while validating published ports")
	}
	bindings := map[portBinding]bool{}
	for _, serviceValue := range mapValue(payload["services"]) {
		service, _ := serviceValue.(map[string]interface{})
		ports, _ := service["ports"].([]interface{})
		for _, portValue := range ports {
			port, _ := portValue.(map[string]interface{})
			published := stringValue(port["published"])
			if published == "" {
				continue
			}
			bounds := strings.SplitN(published, "-", 2)
			first, firstErr := strconv.Atoi(bounds[0])
			last := first
			var lastErr error
			if len(bounds) == 2 {
				last, lastErr = strconv.Atoi(bounds[1])
			}
			if firstErr != nil || lastErr != nil || first < 1 || first > last || last > 65535 {
				return fmt.Errorf("invalid Compose published port '%s'", published)
			}
			protocol := strings.ToLower(stringValue(port["protocol"]))
			if protocol == "" {
				protocol = "tcp"
			}
			if protocol != "tcp" && protocol != "udp" {
				continue
			}
			for current := first; current <= last; current++ {
				bindings[portBinding{Port: current, Protocol: protocol}] = true
			}
		}
	}
	return validateDeploymentPorts(project, bindings)
}

func validateDeploymentPorts(project string, requested map[portBinding]bool) error {
	if len(requested) == 0 {
		return nil
	}
	raw, err := commandOutput(10*time.Second, "docker", "ps", "--format", "{{json .}}")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(raw, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var row map[string]interface{}
		if json.Unmarshal([]byte(line), &row) != nil {
			continue
		}
		name := strings.TrimPrefix(stringValue(firstValue(row, "Names", "Name")), "/")
		labels := parseLabels(stringValue(row["Labels"]))
		if name == project || labels["com.docker.compose.project"] == project {
			continue
		}
		container := stringValue(firstValue(row, "ID", "Id", "ContainerID"))
		inspect, inspectErr := inspectContainer(container)
		if inspectErr != nil {
			continue
		}
		network, _ := inspect["NetworkSettings"].(map[string]interface{})
		for key, mappings := range mapValue(network["Ports"]) {
			parts := strings.SplitN(key, "/", 2)
			protocol := "tcp"
			if len(parts) == 2 {
				protocol = strings.ToLower(parts[1])
			}
			items, _ := mappings.([]interface{})
			for _, mappingValue := range items {
				mapping, _ := mappingValue.(map[string]interface{})
				hostPort, _ := strconv.Atoi(stringValue(mapping["HostPort"]))
				binding := portBinding{Port: hostPort, Protocol: protocol}
				if requested[binding] {
					return fmt.Errorf("deployment port collision: %d/%s already bound by running container '%s'", hostPort, protocol, name)
				}
			}
		}
	}
	return nil
}

func StopDockerfileContainer(project string) (string, error) {
	if _, err := dockerOutput(60*time.Second, "", nil, "rm", "-f", project); err != nil {
		return "", err
	}
	return "Container stopped", nil
}

func RunWorkerCommand(command string, workdir string, environment map[string]string, timeoutSeconds int) (CommandResult, error) {
	return RunWorkerCommandContext(context.Background(), command, workdir, environment, timeoutSeconds)
}

func RunWorkerCommandContext(ctx context.Context, command string, workdir string, environment map[string]string, timeoutSeconds int) (CommandResult, error) {
	args, err := nonInteractiveCommand(command)
	if err != nil {
		return CommandResult{}, err
	}
	timeout := boundedTimeout(timeoutSeconds)
	output, exitCode, timedOut, cancelled := commandOutputWithExitContext(ctx, timeout, workdir, environment, args[0], args[1:]...)
	if cancelled {
		return CommandResult{Message: "Command cancelled", Output: tailText(output, 120000), ExitCode: 130}, context.Canceled
	}
	if timedOut {
		message := fmt.Sprintf("Command timed out after %ds", int(timeout/time.Second))
		if strings.TrimSpace(output) == "" {
			output = message
		}
		return CommandResult{Message: message, Output: tailText(output, 120000), ExitCode: 124}, nil
	}
	if exitCode != 0 {
		message := fmt.Sprintf("Command exited with code %d: %s", exitCode, compactProcessError(output))
		return CommandResult{Message: message, Output: tailText(output, 120000), ExitCode: exitCode}, nil
	}
	if strings.TrimSpace(output) == "" {
		output = "Command completed with no output."
	}
	return CommandResult{Message: "Command completed", Output: tailText(output, 120000), ExitCode: 0}, nil
}

func PublicTunnelTargets(project string, mode string, service string, fallbackPort int, servicePorts map[string]int, workerHostname string) (map[string]string, error) {
	if fallbackPort <= 0 || fallbackPort > 65535 {
		fallbackPort = 3000
	}
	if mode == "compose" {
		raw, err := commandOutput(8*time.Second, "docker", "ps", "--filter", "label=com.docker.compose.project="+project, "--format", "{{json .}}")
		if err != nil {
			return nil, err
		}
		targets := map[string]string{}
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
			labels := parseLabels(stringValue(row["Labels"]))
			serviceName := strings.TrimSpace(labels["com.docker.compose.service"])
			if serviceName == "" {
				serviceName = name
			}
			if service != "" && serviceName != service {
				continue
			}
			port := fallbackPort
			if configured := servicePorts[serviceName]; configured > 0 {
				port = configured
			}
			target, err := containerTunnelTarget(id, port, workerHostname)
			if err == nil && target != "" {
				targets[serviceName] = target
			}
		}
		if len(targets) > 0 {
			return targets, nil
		}
		suffix := ""
		if service != "" {
			suffix = " service " + service
		}
		return nil, fmt.Errorf("no running compose services found for public tunnel '%s'%s", project, suffix)
	}
	target, err := containerTunnelTarget(project, fallbackPort, workerHostname)
	if err != nil || target == "" {
		return nil, fmt.Errorf("no running container found for public tunnel '%s'", project)
	}
	serviceName := strings.TrimSpace(service)
	if serviceName == "" {
		serviceName = "app"
	}
	return map[string]string{serviceName: target}, nil
}

// ContainerTunnelTarget resolves an arbitrary dashboard container reference to
// the same reachable target used by repository tunnels.
func ContainerTunnelTarget(candidates []string, fallbackPort int, workerHostname string) (string, string, error) {
	container, name, err := resolveContainer(candidates)
	if err != nil {
		return "", "", err
	}
	if IsWorkerContainer(container, name) || (workerHostname != "" && (name == workerHostname || strings.HasPrefix(container, workerHostname))) {
		return "", "", fmt.Errorf("worker containers cannot be exposed publicly")
	}
	inspect, err := inspectContainer(container)
	if err != nil {
		return "", "", err
	}
	state, _ := inspect["State"].(map[string]interface{})
	if !boolValue(state["Running"]) {
		return "", "", fmt.Errorf("container must be running to create a public URL")
	}
	if fallbackPort < 1 || fallbackPort > 65535 {
		fallbackPort = 3000
	}
	target, err := containerTunnelTarget(container, fallbackPort, workerHostname)
	if err != nil || target == "" {
		return "", "", fmt.Errorf("could not resolve a tunnel target for local container '%s'. Publish a port or expose a reachable internal port", name)
	}
	return nameOrID(name, container), target, nil
}

func containerTunnelTarget(container string, fallbackPort int, workerHostname string) (string, error) {
	inspect, err := inspectContainer(container)
	if err != nil {
		return "", err
	}
	internalPort := firstInternalPort(inspect)
	if internalPort == 0 {
		internalPort = fallbackPort
	}
	connectWorkerToContainerNetworks(inspect, workerHostname)
	return tunnelTargetFromInspect(inspect, internalPort, fallbackPort)
}

func tunnelTargetFromInspect(inspect map[string]interface{}, internalPort int, fallbackPort int) (string, error) {
	if target := hostPortTarget(inspect, internalPort); target != "" {
		return target, nil
	}
	hostConfig, _ := inspect["HostConfig"].(map[string]interface{})
	if strings.EqualFold(strings.TrimSpace(stringValue(hostConfig["NetworkMode"])), "host") {
		return fmt.Sprintf("http://host.docker.internal:%d", fallbackPort), nil
	}
	if ip := containerIPAddress(inspect); ip != "" {
		return fmt.Sprintf("http://%s:%d", ip, internalPort), nil
	}
	return "", fmt.Errorf("container has no reachable tunnel target")
}

func connectWorkerToContainerNetworks(targetInspect map[string]interface{}, workerHostname string) {
	workerHostname = strings.TrimSpace(workerHostname)
	if workerHostname == "" {
		return
	}
	workerInspect, err := inspectContainer(workerHostname)
	if err != nil {
		return
	}
	targetNetworkSettings, _ := targetInspect["NetworkSettings"].(map[string]interface{})
	workerNetworkSettings, _ := workerInspect["NetworkSettings"].(map[string]interface{})
	targetNetworks := mapValue(targetNetworkSettings["Networks"])
	workerNetworks := mapValue(workerNetworkSettings["Networks"])
	for networkName := range targetNetworks {
		if strings.TrimSpace(networkName) == "" {
			continue
		}
		if _, connected := workerNetworks[networkName]; connected {
			continue
		}
		if _, err := commandOutput(15*time.Second, "docker", "network", "connect", networkName, workerHostname); err == nil {
			workerNetworks[networkName] = map[string]interface{}{}
		}
	}
}

func IsWorkerContainerName(name string) bool {
	normalized := normalizedName(name)
	if normalized == "worker" {
		return true
	}
	return regexp.MustCompile(`(^|[-_])worker([-_]1)?$`).MatchString(normalized)
}

func IsWorkerContainer(containerID string, name string) bool {
	if IsWorkerContainerName(name) {
		return true
	}
	hostname, _ := os.Hostname()
	hostname = strings.TrimSpace(hostname)
	return hostname != "" && (name == hostname || strings.HasPrefix(containerID, hostname))
}

func inspectContainer(container string) (map[string]interface{}, error) {
	raw, err := commandOutput(8*time.Second, "docker", "inspect", container)
	if err != nil {
		return nil, err
	}
	var payload []map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, err
	}
	if len(payload) == 0 {
		return nil, fmt.Errorf("container not found")
	}
	return payload[0], nil
}

func firstInternalPort(inspect map[string]interface{}) int {
	config, _ := inspect["Config"].(map[string]interface{})
	for key := range mapValue(config["ExposedPorts"]) {
		if port := parsePortKey(key); port > 0 {
			return port
		}
	}
	networkSettings, _ := inspect["NetworkSettings"].(map[string]interface{})
	for key := range mapValue(networkSettings["Ports"]) {
		if port := parsePortKey(key); port > 0 {
			return port
		}
	}
	return 0
}

func hostPortTarget(inspect map[string]interface{}, internalPort int) string {
	networkSettings, _ := inspect["NetworkSettings"].(map[string]interface{})
	ports := mapValue(networkSettings["Ports"])
	keys := []string{fmt.Sprintf("%d/tcp", internalPort), fmt.Sprintf("%d/udp", internalPort)}
	for _, key := range keys {
		if target := hostPortFromMapping(ports[key]); target != "" {
			return target
		}
	}
	for _, value := range ports {
		if target := hostPortFromMapping(value); target != "" {
			return target
		}
	}
	return ""
}

func hostPortFromMapping(value interface{}) string {
	items, ok := value.([]interface{})
	if !ok || len(items) == 0 {
		return ""
	}
	first, _ := items[0].(map[string]interface{})
	hostPort := stringValue(first["HostPort"])
	if hostPort == "" {
		return ""
	}
	return "http://host.docker.internal:" + hostPort
}

func containerIPAddress(inspect map[string]interface{}) string {
	networkSettings, _ := inspect["NetworkSettings"].(map[string]interface{})
	networks := mapValue(networkSettings["Networks"])
	for _, value := range networks {
		network, _ := value.(map[string]interface{})
		if ip := stringValue(network["IPAddress"]); ip != "" {
			return ip
		}
	}
	return ""
}

func mapValue(value interface{}) map[string]interface{} {
	if typed, ok := value.(map[string]interface{}); ok {
		return typed
	}
	return map[string]interface{}{}
}

func parsePortKey(value string) int {
	portText := strings.SplitN(value, "/", 2)[0]
	port, _ := strconv.Atoi(portText)
	if port < 1 || port > 65535 {
		return 0
	}
	return port
}

func commandOutput(timeout time.Duration, name string, args ...string) (string, error) {
	output, exitCode, _ := commandOutputWithExit(timeout, "", nil, name, args...)
	if exitCode != 0 {
		return strings.TrimSpace(output), fmt.Errorf("%s", compactProcessError(output))
	}
	return strings.TrimSpace(output), nil
}

func dockerOutput(timeout time.Duration, workdir string, environment map[string]string, args ...string) (string, error) {
	output, exitCode, _ := dockerOutputWithExit(timeout, workdir, environment, args...)
	text := strings.TrimSpace(output)
	if exitCode != 0 {
		return "", fmt.Errorf("%s", compactProcessError(text))
	}
	return text, nil
}

func dockerOutputWithExit(timeout time.Duration, workdir string, environment map[string]string, args ...string) (string, int, bool) {
	return commandOutputWithExit(timeout, workdir, environment, "docker", args...)
}

func dockerOutputWithExitContext(ctx context.Context, timeout time.Duration, workdir string, environment map[string]string, args ...string) (string, int, bool, bool) {
	return commandOutputWithExitContext(ctx, timeout, workdir, environment, "docker", args...)
}

func commandOutputWithExit(timeout time.Duration, workdir string, environment map[string]string, name string, args ...string) (string, int, bool) {
	output, exitCode, timedOut, _ := commandOutputWithExitContext(context.Background(), timeout, workdir, environment, name, args...)
	return output, exitCode, timedOut
}

func commandOutputWithExitContext(ctx context.Context, timeout time.Duration, workdir string, environment map[string]string, name string, args ...string) (string, int, bool, bool) {
	cmd := exec.Command(name, args...)
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
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		return "", 1, false, false
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var err error
	timedOut := false
	cancelled := false
	select {
	case err = <-done:
	case <-ctx.Done():
		cancelled = true
		killProcessGroup(cmd.Process.Pid)
		err = <-done
	case <-timer.C:
		timedOut = true
		killProcessGroup(cmd.Process.Pid)
		err = <-done
	}
	text := strings.TrimSpace(output.String())
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			return text, exitError.ExitCode(), timedOut, cancelled
		}
		return text, 1, timedOut, cancelled
	}
	return text, 0, timedOut, cancelled
}

func killProcessGroup(pid int) {
	if pid <= 0 {
		return
	}
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
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

func boundedTimeout(seconds int) time.Duration {
	if seconds < 5 {
		seconds = 5
	}
	if seconds > 1800 {
		seconds = 1800
	}
	return time.Duration(seconds) * time.Second
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

func boolValue(value interface{}) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		text := strings.ToLower(strings.TrimSpace(typed))
		return text == "true" || text == "1" || text == "yes"
	default:
		return false
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
