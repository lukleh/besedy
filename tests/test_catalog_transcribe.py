"""Tests for catalog transcribe command behavior."""

from __future__ import annotations

import argparse
from pathlib import Path

from besedy.commands.catalog import transcribe as transcribe_module
from besedy.lib.workflow.config import WorkflowConfig
from tests.helpers.workflows import make_workflow_config


def test_handle_transcribe_accepts_namespace_without_hash_filter(monkeypatch):
    """Pipeline-created namespaces without hash_filter should not crash."""

    def fake_resolve_and_load_catalog(_csv, _purpose, _default):
        return None

    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        fake_resolve_and_load_catalog,
    )

    args = argparse.Namespace(
        csv=None,
        limit=None,
    )

    assert transcribe_module.handle_transcribe(args) == 0


def test_handle_transcribe_rejects_unknown_workflow_selection(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    """An unmatched --workflow value names itself and the configured workflows."""
    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        lambda *_args: (tmp_path / "catalog.csv", []),
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(
        transcribe_module,
        "get_transcription_workflows",
        lambda **_kwargs: [
            make_workflow_config(),
            make_workflow_config(workflow_id="canary-nemo-beam", workflow_label="canary-nemo-beam"),
        ],
    )

    request = transcribe_module.TranscribeRequest(
        output_root=tmp_path / "transcripts",
        workflows=["nemo", "faster-whisper"],
    )

    assert transcribe_module.handle_transcribe(request) == 1
    stderr = capsys.readouterr().err
    assert "unknown --workflow value(s): nemo" in stderr
    assert "canary-nemo-beam" in stderr
    assert "faster-whisper" in stderr


def test_handle_transcribe_accepts_workflow_id_prefix(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """A shared prefix keeps selecting its related workflow IDs."""
    beam = make_workflow_config(workflow_id="canary-nemo-beam", workflow_label="canary-nemo-beam")
    selected: list[WorkflowConfig] = []

    class DummyPathBuilder:
        def __init__(self, config: WorkflowConfig) -> None:
            self.config = config

        def workflow_dir(self, _root: Path) -> Path:
            selected.append(self.config)
            return tmp_path / self.config.workflow_id

    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        lambda *_args: (tmp_path / "catalog.csv", []),
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(
        transcribe_module,
        "get_transcription_workflows",
        lambda **_kwargs: [make_workflow_config(), beam],
    )
    monkeypatch.setattr(transcribe_module, "path_builder", DummyPathBuilder)
    monkeypatch.setattr(transcribe_module, "print_workflow_summary", lambda *_args: None)

    request = transcribe_module.TranscribeRequest(
        output_root=tmp_path / "transcripts",
        workflows=["canary"],
    )

    assert transcribe_module.handle_transcribe(request) == 0
    assert selected == [beam]


def test_handle_transcribe_selects_only_requested_language_variant(
    monkeypatch,
    tmp_path: Path,
) -> None:
    automatic = make_workflow_config(vad_model="silero", language="auto")
    english = make_workflow_config(vad_model="silero", language="en")
    selected: list[WorkflowConfig] = []

    class DummyPathBuilder:
        def __init__(self, config: WorkflowConfig) -> None:
            self.config = config

        def workflow_dir(self, _root: Path) -> Path:
            selected.append(self.config)
            return tmp_path / self.config.language

    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        lambda *_args: (tmp_path / "catalog.csv", []),
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(
        transcribe_module,
        "get_transcription_workflows",
        lambda **_kwargs: [automatic, english],
    )
    monkeypatch.setattr(transcribe_module, "path_builder", DummyPathBuilder)
    monkeypatch.setattr(transcribe_module, "print_workflow_summary", lambda *_args: None)

    request = transcribe_module.TranscribeRequest(
        output_root=tmp_path / "transcripts",
        workflows=["faster-whisper"],
        model="large-v3",
        language="EN",
    )

    assert transcribe_module.handle_transcribe(request) == 0
    assert selected == [english]
