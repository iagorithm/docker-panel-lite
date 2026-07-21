package core

import (
	"context"
	"errors"
)

var errDockerSDKNotImplemented = errors.New("Docker SDK backend is not implemented")

// DockerSummaryWithSDK returns the same dashboard summary as DockerSummaryNow,
// using the Docker Engine API instead of invoking the Docker CLI.
//
// TODO: Construct a Docker client from the environment, negotiate the API
// version, fetch daemon info/version, map the result to Summary, and close the
// client. Context cancellation and daemon permission errors must be preserved.
func DockerSummaryWithSDK(ctx context.Context) (Summary, error) {
	return nil, errDockerSDKNotImplemented
}

// ContainerInventoryWithSDK returns all containers in the same record shape as
// ContainerInventory, including Compose labels, published ports and status.
//
// TODO: List running and stopped containers through the Docker Engine API,
// normalize names/labels/ports exactly like the CLI backend, and keep stable
// Docker IDs so existing Firebase container records continue to match.
func ContainerInventoryWithSDK(ctx context.Context) (map[string]ContainerRecord, error) {
	return nil, errDockerSDKNotImplemented
}

// ContainerActionWithSDK executes a lifecycle or log action through the Docker
// Engine API and returns the same message/log-tail contract as ContainerAction.
//
// TODO: Resolve candidates without ambiguous prefix matches, retain worker
// container protection, implement start/stop/restart/remove/logs, enforce
// operation timeouts, and return daemon errors without leaking credentials.
func ContainerActionWithSDK(ctx context.Context, action string, candidates []string) (string, *string, error) {
	return "", nil, errDockerSDKNotImplemented
}

// RunDockerfileWithSDK builds an image and atomically replaces the managed
// project container while preserving the current RunDockerfile behavior.
//
// TODO: Stream and bound build output, support cancellation, pass environment
// and port bindings safely, label managed resources, remove the previous
// container only after a successful build, and clean up partial resources on
// failure. Compose deployments should continue using the Compose CLI plugin.
func RunDockerfileWithSDK(ctx context.Context, project string, repoPath string, dockerfile string, environment map[string]string, ports []string) (string, error) {
	return "", errDockerSDKNotImplemented
}
