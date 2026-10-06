"""Guardrails for the container egress policy (docs/web/egress-isolation.md).

The host policy matches bridges named br-bsdy*, so every network a Besedy
container can join must be created with such a name.
"""

import re
import subprocess
from pathlib import Path

import pytest
import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PREFIX = "br-bsdy"
BRIDGE_OPTION = "com.docker.network.bridge.name"
NETWORK_HELPER = PROJECT_ROOT / "scripts" / "docker_network.sh"
NFT_POLICY = PROJECT_ROOT / "web" / "setup" / "egress" / "besedy-egress.nft"

# Base Compose files; the web overlays only add to web/docker-compose.yml.
BASE_COMPOSE_FILES = [
    "web/docker-compose.yml",
    "jobs-service/docker-compose.jobs-prod.yml",
    "jobs-service/docker-compose.jobs-dev.yml",
    "jobs-service/docker-compose.jobs-test.yml",
    "jobs-service/docker-compose.prefect.yml",
    "rag-services/docker-compose.yml",
    "backends/docker-compose.yml",
]


def _load(relative: str) -> dict:
    return yaml.safe_load((PROJECT_ROOT / relative).read_text(encoding="utf-8"))


def _uses_default_network(compose: dict) -> bool:
    for service in compose.get("services", {}).values():
        networks = service.get("networks")
        if networks is None or "default" in networks:
            return True
    return False


@pytest.mark.parametrize("relative", BASE_COMPOSE_FILES)
def test_every_owned_compose_network_has_a_policy_bridge_name(relative: str) -> None:
    compose = _load(relative)
    networks = compose.get("networks") or {}
    owned = {
        name: spec or {} for name, spec in networks.items() if not (spec or {}).get("external")
    }
    if _uses_default_network(compose):
        assert "default" in owned, (
            f"{relative}: the default network needs a {BRIDGE_PREFIX}* bridge name"
        )

    for name, spec in owned.items():
        bridge = (spec.get("driver_opts") or {}).get(BRIDGE_OPTION, "")
        assert bridge.startswith(BRIDGE_PREFIX) or bridge.startswith("${BESEDY_WEB_BRIDGE_NAME"), (
            f"{relative}: network {name} has bridge name {bridge!r}"
        )
        assert spec.get("enable_ipv6") is False, (
            f"{relative}: network {name} must set enable_ipv6: false"
        )


def test_fixed_bridge_names_are_unique_and_fit_the_interface_limit() -> None:
    names = []
    for relative in BASE_COMPOSE_FILES:
        for spec in (_load(relative).get("networks") or {}).values():
            bridge = ((spec or {}).get("driver_opts") or {}).get(BRIDGE_OPTION)
            if bridge and not bridge.startswith("$"):
                names.append(bridge)
    for network in [
        "besedy-internal",
        "besedy-prefect",
        "besedy-production_default",
        "besedy-development_default",
        "besedy-test_default",
    ]:
        names.append(_bridge_name(network))

    assert len(names) == len(set(names)), names
    assert all(len(name) <= 15 for name in names), names


def _bridge_name(network: str) -> str:
    result = subprocess.run(
        ["bash", str(NETWORK_HELPER), "bridge-name", network],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


@pytest.mark.parametrize(
    ("network", "bridge"),
    [
        ("besedy-internal", "br-bsdy-int"),
        ("besedy-prefect", "br-bsdy-pfct"),
        ("besedy-production_default", "br-bsdy-wprod"),
        ("besedy-development_default", "br-bsdy-wdev"),
        ("besedy-test_default", "br-bsdy-wtest"),
    ],
)
def test_shared_networks_get_readable_bridge_names(network: str, bridge: str) -> None:
    assert _bridge_name(network) == bridge


def test_other_networks_get_a_stable_hashed_bridge_name() -> None:
    first = _bridge_name("besedy-test-mcp-20261006120000-42_default")

    assert re.fullmatch(r"br-bsdy-[0-9a-f]{7}", first)
    assert _bridge_name("besedy-test-mcp-20261006120000-42_default") == first
    assert _bridge_name("besedy-test-mcp-20261006120000-43_default") != first


def test_containers_are_not_pointed_at_the_host() -> None:
    # The policy drops container -> host connections, so a host-gateway alias
    # would only produce timeouts.
    paths = [PROJECT_ROOT / relative for relative in BASE_COMPOSE_FILES]
    paths += sorted((PROJECT_ROOT / "web").glob(".env*.example"))
    paths += sorted((PROJECT_ROOT / "jobs-service").glob(".env*.example"))
    paths.append(PROJECT_ROOT / "web" / "src" / "lib" / "runtime-config.ts")
    for path in paths:
        text = path.read_text(encoding="utf-8")
        assert "host-gateway" not in text, path
        assert "host.docker.internal" not in text, path


def test_colbert_is_reached_over_the_shared_network_and_binds_loopback() -> None:
    rag = _load("rag-services/docker-compose.yml")
    colbert = rag["services"]["colbert"]

    assert colbert["networks"] == ["default", "besedy_internal"]
    assert colbert["ports"] == ["${COLBERT_HOST_BIND:-127.0.0.1}:${COLBERT_HOST_PORT:-8192}:8192"]
    web = _load("web/docker-compose.yml")["services"]["web"]
    assert (
        web["environment"]["RAG_COLBERT_URL"]
        == "${RAG_COLBERT_URL:-http://besedy-colbert:8192/query}"
    )


def test_nft_policy_matches_the_bridge_prefix() -> None:
    policy = NFT_POLICY.read_text(encoding="utf-8")

    assert f'iifname != "{BRIDGE_PREFIX}*" accept' in policy
    for comment in ("host", "private"):
        assert f'counter drop comment "{comment}"' in policy


def _run_ensure(
    tmp_path: Path, inspect_output: str | None
) -> tuple[subprocess.CompletedProcess[str], str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "docker.log"
    inspect = "exit 1" if inspect_output is None else f"echo {inspect_output}; exit 0"
    docker = bin_dir / "docker"
    docker.write_text(
        f"""#!/usr/bin/env bash
printf '%s\\n' "$*" >> {log}
if [[ "$1 $2" == "network inspect" ]]; then {inspect}; fi
""",
        encoding="utf-8",
    )
    docker.chmod(0o755)
    result = subprocess.run(
        ["bash", str(NETWORK_HELPER), "ensure", "besedy-internal"],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=False,
    )
    return result, log.read_text(encoding="utf-8")


def test_ensure_creates_a_missing_network_with_its_bridge_name(tmp_path: Path) -> None:
    result, calls = _run_ensure(tmp_path, None)

    assert result.returncode == 0, result.stderr
    assert (
        "network create --driver bridge --ipv6=false "
        "--opt com.docker.network.bridge.name=br-bsdy-int besedy-internal"
    ) in calls


def test_ensure_warns_about_a_network_created_before_the_bridge_names(tmp_path: Path) -> None:
    result, calls = _run_ensure(tmp_path, "")

    assert result.returncode == 0
    assert "network create" not in calls
    assert "was created without a br-bsdy* bridge name" in result.stderr
