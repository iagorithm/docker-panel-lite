package core

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var ngrokErrorPattern = regexp.MustCompile(`(?i)ERR_NGROK_\d+`)

func IsPublicTunnelURL(candidate string, domain string) bool {
	parsed, err := url.Parse(strings.TrimRight(candidate, ","))
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return false
	}
	hostname := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if hostname == "dashboard.ngrok.com" || hostname == "ngrok.com" || hostname == "www.ngrok.com" || strings.Contains(strings.ToLower(parsed.Path), "/billing/") {
		return false
	}
	if strings.TrimSpace(domain) != "" {
		requested, err := url.Parse("https://" + strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(domain), "https://"), "http://"))
		return err == nil && hostname == strings.ToLower(strings.TrimSuffix(requested.Hostname(), "."))
	}
	return strings.HasSuffix(hostname, ".ngrok.app") || strings.HasSuffix(hostname, ".ngrok-free.app") || strings.HasSuffix(hostname, ".ngrok.io")
}

func ngrokErrorMessage(errorCode string) string {
	code := strings.ToUpper(errorCode)
	if code == "ERR_NGROK_314" {
		return "ERR_NGROK_314: the ngrok account is on the Free plan, so it cannot create a custom hostname. Clear the configured Ngrok domain to use an automatically generated *.ngrok-free.app URL, or upgrade the ngrok account to a paid plan."
	}
	return fmt.Sprintf("ngrok failed with %s: review the ngrok account and billing configuration", code)
}

type Tunnel struct {
	URL       string
	Target    string
	PID       int
	Domain    string
	StartedAt int64
}

type NgrokService struct {
	Root      string
	Enabled   bool
	Authtoken string
	Binary    string
	Region    string
}

func NewNgrokService(dataDir string, enabled bool, authtoken string, binary string, region string) NgrokService {
	if strings.TrimSpace(binary) == "" {
		binary = "ngrok"
	}
	root := filepath.Join(dataDir, "ngrok")
	_ = os.MkdirAll(root, 0700)
	return NgrokService{
		Root:      root,
		Enabled:   enabled,
		Authtoken: strings.TrimSpace(authtoken),
		Binary:    strings.TrimSpace(binary),
		Region:    strings.TrimSpace(region),
	}
}

func (s NgrokService) Current(project string) (*Tunnel, error) {
	state := s.readState(project)
	pid := intValue(state["pid"])
	if !pidRunning(pid) {
		return nil, nil
	}
	url := stringValue(state["url"])
	target := stringValue(state["target"])
	domain := stringValue(state["domain"])
	if url == "" || target == "" || !IsPublicTunnelURL(url, domain) {
		return nil, nil
	}
	return &Tunnel{
		URL:       url,
		Target:    target,
		PID:       pid,
		Domain:    domain,
		StartedAt: int64Value(state["startedAt"]),
	}, nil
}

func (s NgrokService) Start(project string, target string, domain string) (Tunnel, error) {
	if !s.Enabled {
		return Tunnel{}, fmt.Errorf("ngrok is disabled. Set NGROK_ENABLED=true and NGROK_AUTHTOKEN in the worker environment")
	}
	if s.Authtoken == "" && strings.TrimSpace(os.Getenv("NGROK_CONFIG")) == "" {
		return Tunnel{}, fmt.Errorf("NGROK_AUTHTOKEN is required to open public tunnels")
	}
	current, _ := s.Current(project)
	if current != nil && current.Target == target && current.Domain == domain {
		return *current, nil
	}
	s.Stop(project)

	binary, err := exec.LookPath(s.Binary)
	if err != nil {
		return Tunnel{}, fmt.Errorf("ngrok is not installed in this worker image")
	}
	statePath, logPath := s.paths(project)
	args := []string{"http", target, "--log=stdout", "--log-format=logfmt"}
	if strings.TrimSpace(domain) != "" {
		args = append(args, "--url="+strings.TrimSpace(domain))
	}
	if s.Region != "" {
		args = append(args, "--region="+s.Region)
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return Tunnel{}, err
	}
	env := os.Environ()
	if s.Authtoken != "" {
		env = append(env, "NGROK_AUTHTOKEN="+s.Authtoken)
	}
	cmd := exec.Command(binary, args...)
	cmd.Env = env
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return Tunnel{}, err
	}
	_ = logFile.Close()

	deadline := time.Now().Add(30 * time.Second)
	urlPattern := regexp.MustCompile(`https://[^\s"']+`)
	publicURL := ""
	logText := ""
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(logPath)
		logText = tailText(string(data), 20000)
		if errorCode := ngrokErrorPattern.FindString(logText); errorCode != "" {
			_ = cmd.Process.Kill()
			return Tunnel{}, fmt.Errorf("%s", ngrokErrorMessage(errorCode))
		}
		urls := urlPattern.FindAllString(logText, -1)
		for _, item := range urls {
			candidate := strings.TrimRight(item, ",")
			if IsPublicTunnelURL(candidate, domain) {
				publicURL = candidate
				break
			}
		}
		if publicURL != "" {
			break
		}
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			return Tunnel{}, fmt.Errorf("%s", tailText(strings.TrimSpace(logText), 2000))
		}
		if err := cmd.Process.Signal(syscall.Signal(0)); err != nil {
			return Tunnel{}, fmt.Errorf("%s", tailText(strings.TrimSpace(logText), 2000))
		}
		time.Sleep(500 * time.Millisecond)
	}
	if publicURL == "" {
		s.Stop(project)
		if strings.TrimSpace(logText) == "" {
			logText = "ngrok did not publish a URL within 30 seconds"
		}
		return Tunnel{}, fmt.Errorf("%s", tailText(strings.TrimSpace(logText), 2000))
	}
	tunnel := Tunnel{URL: publicURL, Target: target, PID: cmd.Process.Pid, Domain: strings.TrimSpace(domain), StartedAt: nowMillis()}
	state := map[string]interface{}{
		"pid":       tunnel.PID,
		"url":       tunnel.URL,
		"target":    tunnel.Target,
		"domain":    tunnel.Domain,
		"startedAt": tunnel.StartedAt,
		"logPath":   logPath,
	}
	payload, _ := json.MarshalIndent(state, "", "  ")
	_ = os.WriteFile(statePath, payload, 0600)
	return tunnel, nil
}

func (s NgrokService) Stop(project string) {
	statePath, _ := s.paths(project)
	state := s.readState(project)
	pid := intValue(state["pid"])
	if pidRunning(pid) {
		_ = syscall.Kill(pid, syscall.SIGTERM)
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) && pidRunning(pid) {
			time.Sleep(150 * time.Millisecond)
		}
		if pidRunning(pid) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	_ = os.Remove(statePath)
}

func (s NgrokService) StopPrefix(project string) {
	prefix := safeNgrokProject(project) + "--"
	s.Stop(project)
	matches, _ := filepath.Glob(filepath.Join(s.Root, prefix+"*.json"))
	for _, match := range matches {
		name := strings.TrimSuffix(filepath.Base(match), ".json")
		s.Stop(name)
	}
}

func (s NgrokService) paths(project string) (string, string) {
	key := safeNgrokProject(project)
	return filepath.Join(s.Root, key+".json"), filepath.Join(s.Root, key+".log")
}

func (s NgrokService) readState(project string) map[string]interface{} {
	statePath, _ := s.paths(project)
	data, err := os.ReadFile(statePath)
	if err != nil {
		return map[string]interface{}{}
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return map[string]interface{}{}
	}
	return payload
}

func safeNgrokProject(value string) string {
	cleaned := regexp.MustCompile(`[^A-Za-z0-9_.-]+`).ReplaceAllString(strings.TrimSpace(value), "-")
	cleaned = strings.Trim(cleaned, ".-")
	if cleaned == "" {
		return "project"
	}
	return cleaned
}

func pidRunning(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, syscall.Signal(0)) == nil
}

func int64Value(value interface{}) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed
	default:
		return 0
	}
}
