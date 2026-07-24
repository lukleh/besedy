from pathlib import Path

import pytest

from besedy.core.paths import PROJECT_ROOT
from besedy.lib import rag_colbert_runtime_config


@pytest.mark.parametrize(
    ("has_gpu", "expected"),
    [(True, "docker-indexer"), (False, "docker")],
)
def test_default_runtime_uses_host_capability(has_gpu: bool, expected: str) -> None:
    assert (
        rag_colbert_runtime_config.default_colbert_index_runtime(has_nvidia_gpu=lambda: has_gpu)
        == expected
    )


def test_resolve_colbert_runtime_prefers_explicit_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker")

    assert (
        rag_colbert_runtime_config.resolve_colbert_runtime(" Docker-Indexer ") == "docker-indexer"
    )


def test_resolve_colbert_runtime_rejects_unknown_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "host")

    with pytest.raises(RuntimeError, match="BESEDY_COLBERT_RUNTIME.*'docker'.*'docker-indexer'"):
        rag_colbert_runtime_config.resolve_colbert_runtime()


def test_docker_worker_payload_translates_only_path_fields() -> None:
    manifest_path = PROJECT_ROOT / "tmp" / "manifest.jsonl"
    index_dir = PROJECT_ROOT / "tmp" / "index"

    assert rag_colbert_runtime_config.docker_worker_payload(
        {
            "manifest_path": str(manifest_path),
            "colbert_index_dir": str(index_dir),
            "query": "unchanged",
        }
    ) == {
        "manifest_path": "/workspace/besedy/tmp/manifest.jsonl",
        "colbert_index_dir": "/workspace/besedy/tmp/index",
        "query": "unchanged",
    }


def test_external_bundle_context_mounts_bundle_and_preserves_relative_paths(
    tmp_path: Path,
) -> None:
    bundle_dir = tmp_path / "bundle"
    payload = {
        "manifest_path": str(bundle_dir / "chunk_manifest.jsonl"),
        "colbert_index_dir": str(bundle_dir / "colbert_index"),
    }

    translated, volume_args, container_bundle_dir = (
        rag_colbert_runtime_config.docker_bundle_payload_context(payload)
    )

    assert translated == {
        "manifest_path": "/workspace/colbert-indexer-bundle/chunk_manifest.jsonl",
        "colbert_index_dir": "/workspace/colbert-indexer-bundle/colbert_index",
    }
    assert volume_args == [
        "-v",
        f"{bundle_dir}:/workspace/colbert-indexer-bundle:rw",
    ]
    assert container_bundle_dir == "/workspace/colbert-indexer-bundle"


def test_external_bundle_context_rejects_non_bundle_local_manifest(tmp_path: Path) -> None:
    bundle_dir = tmp_path / "bundle"

    with pytest.raises(RuntimeError, match="bundle-local paths"):
        rag_colbert_runtime_config.docker_bundle_payload_context(
            {
                "manifest_path": str(tmp_path / "elsewhere" / "manifest.jsonl"),
                "colbert_index_dir": str(bundle_dir / "colbert_index"),
            }
        )
