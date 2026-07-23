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

func NgrokErrorMessage(errorCode string) string {
	code := strings.ToUpper(errorCode)
	exact := map[string]string{
		"ERR_NGROK_102":  "The last payment for this ngrok account failed. Update the payment method in the ngrok billing dashboard.",
		"ERR_NGROK_103":  "This ngrok account is suspended. Review the account status or contact ngrok support.",
		"ERR_NGROK_105":  "The saved value is not a valid ngrok authtoken. Copy a new authtoken from the ngrok dashboard and save the project again.",
		"ERR_NGROK_106":  "The saved credential is a legacy ngrok v1 token and is not supported. Generate a current authtoken and save the project again.",
		"ERR_NGROK_107":  "The authtoken is invalid, reset, revoked, or belongs to a team the user can no longer access. Generate and save a new token.",
		"ERR_NGROK_108":  "The account reached its simultaneous ngrok agent-session limit. Stop an active Public URL or agent at https://dashboard.ngrok.com/agents, then retry; otherwise upgrade the account. Each worker ngrok process counts as one session.",
		"ERR_NGROK_115":  "This worker's public IP is blocked by the ngrok account's Agent IP Restrictions. Allow the worker IP in the ngrok dashboard.",
		"ERR_NGROK_120":  "The ngrok agent in the worker image is no longer supported. Rebuild the worker with a current ngrok release.",
		"ERR_NGROK_247":  "The ngrok account is suspended for non-payment. Pay the outstanding balance in the ngrok billing dashboard.",
		"ERR_NGROK_300":  "The ngrok authtoken credential has been revoked. Generate and save a new project token.",
		"ERR_NGROK_307":  "The configured ngrok address must be reserved in this account before it can be used.",
		"ERR_NGROK_309":  "The configured ngrok address is reserved by another account. Clear it or use a domain owned by this token's account.",
		"ERR_NGROK_314":  "The ngrok account is on the Free plan or another plan that cannot create a custom hostname. Clear the configured Ngrok domain to use an automatically generated *.ngrok-free.app URL, or upgrade the account.",
		"ERR_NGROK_319":  "The configured custom hostname is not reserved in this ngrok account. Reserve it first or clear the Ngrok domain field.",
		"ERR_NGROK_320":  "The configured domain is reserved by another ngrok account. Use the token for the owning account or choose another domain.",
		"ERR_NGROK_324":  "The ngrok agent session reached its endpoint limit. Stop an endpoint or upgrade the ngrok account.",
		"ERR_NGROK_334":  "The configured endpoint is already online in another ngrok agent. Stop the existing endpoint before retrying.",
		"ERR_NGROK_400":  "The configured ngrok region is invalid. Correct or remove NGROK_REGION in the worker configuration.",
		"ERR_NGROK_8012": "ngrok is online, but it cannot connect to the application upstream. Confirm the container is running, the internal port is correct, and the service is reachable from the worker.",
		"ERR_NGROK_8013": "This free ngrok account requires a payment card before it can open TCP endpoints.",
		"ERR_NGROK_8014": "ngrok blocked this agent for a suspected Acceptable Use Policy violation. Review the account and contact ngrok support.",
	}
	if detail, ok := exact[code]; ok {
		return code + ": " + detail
	}
	number, _ := strconv.Atoi(strings.TrimPrefix(code, "ERR_NGROK_"))
	detail := "ngrok rejected the tunnel request. See https://ngrok.com/docs/errors/" + strings.ToLower(code) + " for the exact account or configuration requirement."
	switch {
	case number == 310 || number == 313 || number == 315 || number == 401:
		detail = "The configured domain feature is not available on this ngrok plan. Clear the Ngrok domain field or upgrade the account."
	case number == 308 || number == 316:
		detail = "The authtoken credential policy does not permit using the configured domain. Review the credential ACL or use another token."
	case number == 311 || number == 317 || number == 322:
		detail = "The configured domain and worker region do not match. Correct NGROK_REGION or select a domain available in that region."
	case number == 326 || number == 327 || number == 347 || number == 354 || number == 355 || number == 396 || number == 397:
		detail = "The configured Ngrok domain is invalid. Correct it or clear the field to request an automatically generated URL."
	case number == 337 || number == 338:
		detail = "The ngrok account has a billing or suspension problem. Review the account status and billing dashboard."
	case number == 348 || number == 349:
		detail = "The ngrok account reached a session limit or session creation rate limit. Stop an active agent, wait, or upgrade the account."
	case number == 350 || number == 351:
		detail = "The ngrok account reached an endpoint limit or endpoint creation rate limit. Stop an endpoint, wait, or upgrade the account."
	case number == 3208:
		detail = "The ngrok account was banned for a Terms of Service violation. Contact ngrok support if this is unexpected."
	case number >= 8000 && number <= 8011:
		detail = "The worker could not establish ngrok network connectivity. Check DNS, outbound internet, proxy, firewall, TLS inspection, and IPv6 configuration."
	}
	return code + ": " + detail
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
		return Tunnel{}, fmt.Errorf("ngrok is disabled. Enable it in the compiled Go configuration or save an ngrok token in the project")
	}
	if s.Authtoken == "" {
		return Tunnel{}, fmt.Errorf("an ngrok authtoken is required in the project or compiled Go configuration")
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
			return Tunnel{}, fmt.Errorf("%s", NgrokErrorMessage(errorCode))
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
