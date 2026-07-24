"""Tests for catalog speaker clustering command behavior."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

from besedy.commands.catalog import speakers as speakers_module


def test_handle_cluster_speakers_mounts_audio_inputs_for_docker(
    monkeypatch,
    tmp_path: Path,
) -> None:
    input_dir = tmp_path / "diarization"
    hash_dir = input_dir / "abc12345"
    hash_dir.mkdir(parents=True)
    audio_dir = tmp_path / "staged"
    audio_dir.mkdir()
    audio_path = audio_dir / "sample.wav"
    audio_path.write_bytes(b"wav")
    (hash_dir / "speakers.json").write_text(
        json.dumps(
            {
                "audio_file": str(audio_path),
                "segments": [{"speaker": "SPEAKER_01", "start": 0.0, "end": 1.0}],
            }
        ),
        encoding="utf-8",
    )

    captured: dict[str, object] = {}

    def fake_build_python_backend_process(**kwargs):
        captured["kwargs"] = kwargs
        return SimpleNamespace(argv=("echo", "ok"), extra_env=None)

    def fake_run(cmd, **_kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(
        speakers_module, "build_python_backend_process", fake_build_python_backend_process
    )
    monkeypatch.setattr(speakers_module.subprocess, "run", fake_run)
    monkeypatch.setenv("HF_TOKEN", "secret-token")

    output_path = tmp_path / "clusters.json"
    embedding_cache_dir = tmp_path / "embeddings"
    args = argparse.Namespace(
        cpu=False,
        model=None,
        input_dir=input_dir,
        cluster_distance=None,
        min_duration=None,
        embedding_cache_mode=None,
        embedding_cache_dir=embedding_cache_dir,
        refresh_embedding_cache=False,
        output=output_path,
        no_symlink=True,
        hashes=[],
    )

    result = speakers_module.handle_cluster_speakers(args)

    assert result == 0
    input_paths = captured["kwargs"]["input_paths"]
    assert input_dir in input_paths
    assert audio_path in input_paths
    extra_env = captured["kwargs"]["extra_env"]
    assert extra_env["HF_TOKEN"] == "secret-token"
    assert extra_env["TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"] == "1"
