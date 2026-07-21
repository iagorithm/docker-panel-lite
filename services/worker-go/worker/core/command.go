package core

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func splitCommand(command string) ([]string, error) {
	args := []string{}
	current := strings.Builder{}
	quote := rune(0)
	escaped := false
	for _, char := range strings.TrimSpace(command) {
		if escaped {
			current.WriteRune(char)
			escaped = false
			continue
		}
		if char == '\\' {
			escaped = true
			continue
		}
		if quote != 0 {
			if char == quote {
				quote = 0
			} else {
				current.WriteRune(char)
			}
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			continue
		}
		if char == ' ' || char == '\t' || char == '\n' || char == '\r' {
			if current.Len() > 0 {
				args = append(args, current.String())
				current.Reset()
			}
			continue
		}
		current.WriteRune(char)
	}
	if escaped {
		current.WriteRune('\\')
	}
	if quote != 0 {
		return nil, fmt.Errorf("command has an unterminated quote")
	}
	if current.Len() > 0 {
		args = append(args, current.String())
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("command is empty")
	}
	return args, nil
}

func nonInteractiveCommand(command string) ([]string, error) {
	args, err := splitCommand(command)
	if err != nil {
		return nil, err
	}
	if !isComposeCommand(args) || !contains(args, "exec") {
		return args, nil
	}
	execIndex := indexOf(args, "exec")
	normalized := append([]string{}, args[:execIndex+1]...)
	tail := args[execIndex+1:]
	if !contains(tail, "-T") && !contains(tail, "--no-TTY") {
		normalized = append(normalized, "-T")
	}
	for _, item := range tail {
		switch item {
		case "-i", "-t", "-it", "-ti", "--interactive", "--tty":
			continue
		default:
			normalized = append(normalized, item)
		}
	}
	return normalized, nil
}

func containerExecShellCommand(command string) (string, error) {
	args, err := splitCommand(command)
	if err != nil {
		return "", err
	}
	if !isComposeCommand(args) || !contains(args, "exec") {
		return command, nil
	}
	index := indexOf(args, "exec") + 1
	optionsWithValue := map[string]bool{"-e": true, "--env": true, "-u": true, "--user": true, "-w": true, "--workdir": true, "--index": true}
	for index < len(args) {
		item := args[index]
		if item == "-i" || item == "-t" || item == "-it" || item == "-ti" || item == "-T" || item == "--interactive" || item == "--tty" || item == "--no-TTY" || item == "--privileged" {
			index++
			continue
		}
		if optionsWithValue[item] {
			index += 2
			continue
		}
		if strings.HasPrefix(item, "--env=") || strings.HasPrefix(item, "--user=") || strings.HasPrefix(item, "--workdir=") || strings.HasPrefix(item, "--index=") {
			index++
			continue
		}
		if strings.HasPrefix(item, "-") {
			index++
			continue
		}
		break
	}
	if index >= len(args)-1 {
		return "", fmt.Errorf("compose exec command must include a service and command")
	}
	return shellJoin(args[index+1:]), nil
}

func isComposeCommand(args []string) bool {
	return len(args) > 0 && (args[0] == "docker-compose" || (len(args) > 1 && args[0] == "docker" && args[1] == "compose"))
}

func WriteComposeOverride(project string, dataDir string, environment map[string]string, composeFile string, configuredService string) (string, error) {
	if len(environment) == 0 {
		return "", nil
	}
	services := composeServiceNames(composeFile)
	if len(services) == 0 {
		service := strings.TrimSpace(configuredService)
		if service == "" {
			service = "web"
		}
		services = []string{service}
	}
	overrideDir := filepath.Join(dataDir, "overrides")
	if err := os.MkdirAll(overrideDir, 0700); err != nil {
		return "", err
	}
	override := filepath.Join(overrideDir, project+".environment.yml")
	builder := strings.Builder{}
	builder.WriteString("services:\n")
	for _, service := range services {
		builder.WriteString("  ")
		builder.WriteString(yamlKey(service))
		builder.WriteString(":\n")
		builder.WriteString("    environment:\n")
		for key, value := range environment {
			if regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(key) {
				builder.WriteString("      ")
				builder.WriteString(key)
				builder.WriteString(": ")
				builder.WriteString(yamlString(value))
				builder.WriteString("\n")
			}
		}
	}
	if err := os.WriteFile(override, []byte(builder.String()), 0600); err != nil {
		return "", err
	}
	return override, nil
}

func composeServiceNames(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	inServices := false
	servicesIndent := -1
	result := []string{}
	keyPattern := regexp.MustCompile(`^([A-Za-z0-9_.-]+):\s*(?:#.*)?$`)
	for _, raw := range lines {
		line := strings.TrimRight(raw, " \t\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if !inServices {
			if indent == 0 && trimmed == "services:" {
				inServices = true
				servicesIndent = indent
			}
			continue
		}
		if indent <= servicesIndent {
			break
		}
		if indent == servicesIndent+2 {
			if match := keyPattern.FindStringSubmatch(trimmed); match != nil {
				result = append(result, match[1])
			}
		}
	}
	return result
}

func shellJoin(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		if regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]+$`).MatchString(arg) {
			quoted = append(quoted, arg)
			continue
		}
		quoted = append(quoted, "'"+strings.ReplaceAll(arg, "'", "'\\''")+"'")
	}
	return strings.Join(quoted, " ")
}

func yamlKey(value string) string {
	if regexp.MustCompile(`^[A-Za-z0-9_.-]+$`).MatchString(value) {
		return value
	}
	return yamlString(value)
}

func yamlString(value string) string {
	escaped := strings.ReplaceAll(value, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "\"", "\\\"")
	escaped = strings.ReplaceAll(escaped, "\r\n", "\n")
	escaped = strings.ReplaceAll(escaped, "\r", "\n")
	escaped = strings.ReplaceAll(escaped, "\n", "\\n")
	return "\"" + escaped + "\""
}

func contains(values []string, target string) bool {
	return indexOf(values, target) >= 0
}

func indexOf(values []string, target string) int {
	for index, value := range values {
		if value == target {
			return index
		}
	}
	return -1
}
