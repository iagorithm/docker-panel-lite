package core

import (
	"strings"
	"testing"
)

func TestConfiguredPortBindingsMatchPythonContract(t *testing.T) {
	bindings, err := configuredPortBindings([]string{"8080:80", "5353:53/udp"})
	if err != nil {
		t.Fatalf("expected valid bindings: %v", err)
	}
	if !bindings[portBinding{Port: 8080, Protocol: "tcp"}] || !bindings[portBinding{Port: 5353, Protocol: "udp"}] {
		t.Fatalf("unexpected bindings: %#v", bindings)
	}
}

func TestConfiguredPortBindingsRejectDuplicates(t *testing.T) {
	_, err := configuredPortBindings([]string{"8080:80", "8080:3000/tcp"})
	if err == nil || !strings.Contains(err.Error(), "declared more than once") {
		t.Fatalf("expected duplicate port error, got %v", err)
	}
}

func TestHostNetworkTunnelUsesConfiguredInternalPort(t *testing.T) {
	inspect := map[string]interface{}{
		"Config":          map[string]interface{}{"ExposedPorts": map[string]interface{}{}},
		"HostConfig":      map[string]interface{}{"NetworkMode": "host"},
		"NetworkSettings": map[string]interface{}{"Networks": map[string]interface{}{}, "Ports": map[string]interface{}{}},
	}
	target, err := tunnelTargetFromInspect(inspect, 8080, 8080)
	if err != nil {
		t.Fatalf("expected host-network target: %v", err)
	}
	if target != "http://host.docker.internal:8080" {
		t.Fatalf("unexpected target: %s", target)
	}
}

func TestCommandParserPreservesBackslashInsideSingleQuotes(t *testing.T) {
	args, err := splitCommand(`printf '%s' 'a\b'`)
	if err != nil {
		t.Fatalf("parse command: %v", err)
	}
	if len(args) != 3 || args[2] != `a\b` {
		t.Fatalf("unexpected parsed args: %#v", args)
	}
}
