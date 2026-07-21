import unittest

from worker.executor import _container_tunnel_target, _configured_port_bindings, _validate_deployment_ports
from worker.core.utils import parse_ports


class FakeContainer:
    attrs = {
        "Config": {"ExposedPorts": {}},
        "HostConfig": {"NetworkMode": "host"},
        "NetworkSettings": {"Networks": {}, "Ports": {}},
    }


class TunnelTargetTests(unittest.TestCase):
    def test_host_network_uses_configured_internal_port(self):
        target = _container_tunnel_target(FakeContainer(), 8080)

        self.assertEqual(target, "http://host.docker.internal:8080")


class FakeRunningContainer:
    def __init__(self, name, host_port, project=""):
        self.name = name
        self.labels = {"com.docker.compose.project": project} if project else {}
        self.attrs = {
            "NetworkSettings": {
                "Ports": {"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": str(host_port)}]}
            }
        }


class FakeContainers:
    def __init__(self, containers):
        self._containers = containers

    def list(self, all=False):
        return self._containers


class FakeClient:
    def __init__(self, containers):
        self.containers = FakeContainers(containers)


class DeploymentPortValidationTests(unittest.TestCase):
    def test_rejects_port_bound_by_another_project(self):
        client = FakeClient([FakeRunningContainer("other-web", 8080, "other")])

        with self.assertRaisesRegex(RuntimeError, "8080/tcp.*other-web"):
            _validate_deployment_ports(client, "current", {(8080, "tcp")})

    def test_allows_port_bound_by_same_project(self):
        client = FakeClient([FakeRunningContainer("current-web-1", 8080, "current")])

        _validate_deployment_ports(client, "current", {(8080, "tcp")})

    def test_validates_dockerfile_mapping(self):
        self.assertEqual(_configured_port_bindings("8080:80, 5353:53/udp"), {(8080, "tcp"), (5353, "udp")})
        self.assertEqual(parse_ports("8080:80, 5353:53/udp"), {"80/tcp": 8080, "53/udp": 5353})


if __name__ == "__main__":
    unittest.main()
