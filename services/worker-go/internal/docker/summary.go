package docker

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type Summary map[string]interface{}

func SummaryNow() Summary {
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
