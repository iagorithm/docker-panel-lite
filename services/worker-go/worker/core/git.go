package core

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type GitResult struct {
	Message string
}

func SyncRepo(repoURL string, dest string, token string, branch string) (GitResult, error) {
	if isGitRepo(dest) {
		return PullRepo(dest, token, branch)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return GitResult{}, fmt.Errorf("could not create clone directory '%s': %w", filepath.Dir(dest), err)
	}
	if info, err := os.Stat(dest); err == nil {
		if !info.IsDir() {
			return GitResult{}, fmt.Errorf("clone destination '%s' exists and is not a directory", dest)
		}
		entries, err := os.ReadDir(dest)
		if err != nil {
			return GitResult{}, fmt.Errorf("could not inspect clone destination '%s': %w", dest, err)
		}
		if len(entries) > 0 {
			return GitResult{}, fmt.Errorf("clone destination '%s' exists and is not an empty Git repository", dest)
		}
	}
	return CloneRepo(repoURL, dest, token, branch)
}

func CloneRepo(repoURL string, dest string, token string, branch string) (GitResult, error) {
	args := []string{"clone"}
	if strings.TrimSpace(branch) != "" {
		args = append(args, "--branch", strings.TrimSpace(branch))
	}
	args = append(args, injectToken(repoURL, token), dest)
	if _, err := gitOutput(300*time.Second, token, args...); err != nil {
		return GitResult{}, err
	}
	return GitResult{Message: "Repository cloned"}, nil
}

func PullRepo(repoPath string, token string, branch string) (GitResult, error) {
	branch = strings.TrimSpace(branch)
	if branch != "" {
		if _, err := gitOutput(300*time.Second, token, "-C", repoPath, "fetch", "origin", "+refs/heads/"+branch+":refs/remotes/origin/"+branch); err != nil {
			return GitResult{}, err
		}
		_, localErr := gitOutput(30*time.Second, token, "-C", repoPath, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
		switchArgs := []string{"-C", repoPath, "switch", branch}
		if localErr != nil {
			switchArgs = []string{"-C", repoPath, "switch", "--track", "-c", branch, "origin/" + branch}
		}
		if _, err := gitOutput(60*time.Second, token, switchArgs...); err != nil {
			return GitResult{}, err
		}
	}
	args := []string{"-C", repoPath, "pull", "--ff-only"}
	if branch != "" {
		args = append(args, "origin", branch)
	}
	if _, err := gitOutput(300*time.Second, token, args...); err != nil {
		return GitResult{}, err
	}
	if branch != "" {
		return GitResult{Message: "Repository updated from branch '" + branch + "'"}, nil
	}
	return GitResult{Message: "Repository updated"}, nil
}

func ListRemoteBranches(repoURL string, token string) ([]string, error) {
	output, err := gitOutput(30*time.Second, token, "ls-remote", "--symref", injectToken(repoURL, token), "HEAD", "refs/heads/*")
	if err != nil {
		return nil, err
	}
	defaultBranch := ""
	branches := map[string]bool{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ref: refs/heads/") && strings.HasSuffix(line, "\tHEAD") {
			defaultBranch = strings.TrimSuffix(strings.TrimPrefix(line, "ref: refs/heads/"), "\tHEAD")
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) == 2 && strings.HasPrefix(parts[1], "refs/heads/") {
			branches[strings.TrimPrefix(parts[1], "refs/heads/")] = true
		}
	}
	ordered := make([]string, 0, len(branches))
	for branch := range branches {
		ordered = append(ordered, branch)
	}
	sort.Slice(ordered, func(i, j int) bool {
		return strings.ToLower(ordered[i]) < strings.ToLower(ordered[j])
	})
	if defaultBranch != "" {
		for index, branch := range ordered {
			if branch == defaultBranch {
				ordered = append(ordered[:index], ordered[index+1:]...)
				ordered = append([]string{defaultBranch}, ordered...)
				break
			}
		}
	}
	return ordered, nil
}

func isGitRepo(path string) bool {
	info, err := os.Stat(filepath.Join(path, ".git"))
	return err == nil && info.IsDir()
}

func injectToken(repoURL string, token string) string {
	if strings.TrimSpace(token) == "" || !strings.HasPrefix(repoURL, "https://") {
		return repoURL
	}
	return strings.Replace(repoURL, "https://", "https://x-access-token:"+url.QueryEscape(token)+"@", 1)
}

func gitOutput(timeout time.Duration, token string, args ...string) (string, error) {
	ctxDone := time.After(timeout)
	cmd := exec.Command("git", args...)
	outputCh := make(chan struct {
		text string
		err  error
	}, 1)
	go func() {
		output, err := cmd.CombinedOutput()
		outputCh <- struct {
			text string
			err  error
		}{text: strings.TrimSpace(string(output)), err: err}
	}()
	select {
	case result := <-outputCh:
		if result.err != nil {
			return "", fmt.Errorf("%s", sanitizeOutput(result.text, token))
		}
		return result.text, nil
	case <-ctxDone:
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		return "", fmt.Errorf("timed out while running git")
	}
}

func sanitizeOutput(output string, token string) string {
	if strings.TrimSpace(token) == "" {
		return output
	}
	return strings.ReplaceAll(strings.ReplaceAll(output, token, "***"), url.QueryEscape(token), "***")
}
