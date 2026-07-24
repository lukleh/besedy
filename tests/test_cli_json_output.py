from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def test_catalog_check_json_is_enveloped(capsys) -> None:
    from besedy.commands.catalog.check import handle_check

    args = argparse.Namespace(
        csv=Path("does_not_exist.csv"),
        csv_normalized=Path("audio_catalog_normalized.csv"),
        verbose=False,
        format="json",
    )

    exit_code = handle_check(args)
    assert exit_code == 1

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["name"] == "check"
    assert payload["status"] == "error"
    assert payload["result"]["error"] == "catalog_csv_missing"


def test_catalog_check_json_includes_colbert_bundle_status(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    from besedy.commands.catalog.check import handle_check
    from besedy.lib.catalog.validator import CatalogEntry, ValidationResult

    backend = "faster-whisper/large-v3@silero_vad_v6"
    diar_backend = "speaker_diarization/pyannote_speaker-diarization-community-1"
    hash_a = "a" * 64
    hash_b = "b" * 64

    csv_path = tmp_path / "audio_catalog_20260101_000000.csv"
    csv_path.write_text("Hash,Full Path\n", encoding="utf-8")
    normalized_path = tmp_path / "audio_catalog_20260101_000000_normalized.csv"
    normalized_path.write_text("Hash,Full Path\n", encoding="utf-8")
    transcripts_root = tmp_path / "transcripts_20260101_000000"
    transcripts_root.mkdir()

    catalog_entries = [
        CatalogEntry(
            sha256=hash_a,
            filename="a.wav",
            full_path=str(tmp_path / "a.wav"),
            duration_str="00:01:00",
            duration_seconds=60.0,
        ),
        CatalogEntry(
            sha256=hash_b,
            filename="b.wav",
            full_path=str(tmp_path / "b.wav"),
            duration_str="00:01:00",
            duration_seconds=60.0,
        ),
    ]

    validation_result = ValidationResult(
        catalog_entries=2,
        normalized_entries=2,
        staged_files_found=2,
        staged_files_missing=0,
        transcripts_found=2,
        transcripts_missing=0,
        orphaned_staged=0,
        orphaned_transcripts=0,
        missing_hashes=[],
        missing_normalized_hashes=[],
        missing_original_hashes=[],
        normalized_only_hashes=[],
        orphaned_staged_hashes=[],
        orphaned_transcript_hashes=[],
        entries_with_all_backends=2,
        entries_missing_backends=[],
        diarization_found=2,
        diarization_missing=0,
        orphaned_diarization=0,
        missing_diarization_hashes=[],
        orphaned_diarization_hashes=[],
        entries_with_all_diarization_backends=2,
        entries_missing_diarization_backends=[],
        backend_counts={backend: 2},
        diarization_backend_counts={diar_backend: 2},
    )

    monkeypatch.setattr(
        "besedy.commands.catalog.check.resolve_catalog_csv",
        lambda *_args, **_kwargs: csv_path,
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.resolve_transcripts_parent",
        lambda: tmp_path,
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.load_catalog_csv",
        lambda _path: catalog_entries,
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.require_loudness_catalog",
        lambda *_args, **_kwargs: (
            True,
            None,
            {"total": 2, "expected": 2, "missing": 0, "stale": 0, "missing_metrics": 0},
        ),
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.require_archived_audio",
        lambda *_args, **_kwargs: (
            True,
            None,
            {
                "total": 2,
                "expected": 2,
                "missing": 0,
                "stale": 0,
                "missing_paths": 0,
                "missing_files": 0,
            },
        ),
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.require_transcript_exports",
        lambda *_args, **_kwargs: (
            True,
            None,
            {backend: {"total": 2, "expected": 2, "missing": 0, "stale": 0}},
        ),
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.require_speaker_clusters",
        lambda *_args, **_kwargs: (
            True,
            None,
            {diar_backend: {"total": 2, "expected": 2, "missing": 0, "sample_overlap": 2}},
        ),
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.require_colbert_bundles",
        lambda *_args, **_kwargs: (
            True,
            None,
            {"total": 1, "expected": 1, "missing": 0},
        ),
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.expected_asr_backends_from_code",
        lambda: [backend],
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.expected_diarization_backends_from_code",
        lambda: [diar_backend],
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.validate_catalog",
        lambda *_args, **_kwargs: validation_result,
    )
    monkeypatch.setattr(
        "besedy.commands.catalog.check.format_validation_report",
        lambda _result, verbose=False: ("CATALOG VALIDATION REPORT", False),
    )

    args = argparse.Namespace(
        csv=csv_path,
        csv_normalized=None,
        verbose=False,
        format="json",
    )

    exit_code = handle_check(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["name"] == "check"
    assert payload["status"] == "success"
    assert payload["result"]["pipeline_artifacts"]["colbert_bundle"]["ok"] is True
    assert "rag_index" not in payload["result"]["derived_directories"]


def test_catalog_clean_json_is_enveloped(capsys) -> None:
    from besedy.commands.catalog.clean import handle_clean

    args = argparse.Namespace(
        csv=Path("does_not_exist.csv"),
        csv_normalized=Path("audio_catalog_normalized.csv"),
        execute=False,
        force=False,
        verbose=False,
        format="json",
    )

    exit_code = handle_clean(args)
    assert exit_code == 1

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["name"] == "clean"
    assert payload["status"] == "error"
    assert payload["result"]["error"] == "catalog_csv_missing"


def test_catalog_clean_execute_removes_missing_catalog_entry(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    from besedy.commands.catalog.clean import handle_clean

    target_hash = "a" * 64
    csv_path = tmp_path / "audio_catalog_20260101_000000.csv"
    missing_original = tmp_path / "missing.wav"
    csv_path.write_text(
        f"Hash,Full Path\n{target_hash},{missing_original.as_posix()}\n",
        encoding="utf-8",
    )

    transcripts_root = tmp_path / "transcripts_20260101_000000"
    transcripts_root.mkdir()

    monkeypatch.setattr(
        "besedy.commands.catalog.clean.resolve_transcripts_root",
        lambda: transcripts_root,
    )

    args = argparse.Namespace(
        csv=csv_path,
        csv_normalized=tmp_path / "audio_catalog_normalized.csv",
        execute=True,
        force=True,
        prune_orphans=False,
        verbose=False,
        format="json",
    )

    exit_code = handle_clean(args)
    assert exit_code == 0

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["name"] == "clean"
    assert payload["status"] == "success"
    assert payload["result"]["hashes_removed"] == 1
    assert "rag_db_cleanup" not in payload["result"]
    assert csv_path.read_text(encoding="utf-8").strip() == "Hash,Full Path"


def test_find_duplicates_json_is_enveloped(capsys) -> None:
    from besedy.commands.catalog.duplicates import handle_find_duplicates

    args = argparse.Namespace(
        directory=None,
        catalog=Path("does_not_exist.csv"),
        output=None,
        delete=False,
        dry_run=False,
        format="json",
    )

    exit_code = handle_find_duplicates(args)
    assert exit_code == 1

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["name"] == "find-duplicates"
    assert payload["status"] == "error"
    assert payload["result"]["error"] == "catalog_not_found"


def test_analyze_validate_json_is_enveloped(tmp_path) -> None:
    """Ensure analyze validate --format json emits a single JSON envelope."""
    from tests.helpers.transcript import create_transcript_with_words, write_transcript_json

    transcripts_root = tmp_path / "transcripts"
    transcript_path = (
        transcripts_root
        / "faster-whisper"
        / "large-v3@silero_vad_v6"
        / "abc123def456"
        / "transcript.json"
    )
    write_transcript_json(
        transcript_path,
        create_transcript_with_words(words=["Hello", "world", "test"], confidence=0.9),
    )

    config_path = tmp_path / "besedy.toml"
    config_path.write_text(
        "\n".join(
            [
                "[paths]",
                f'text_data_dir = "{tmp_path.as_posix()}"',
                'transcripts_dir = "transcripts"',
                f'speaker_clusters_dir = "{(tmp_path / "speaker_clusters").as_posix()}"',
                "",
                "[audio]",
                "sample_rate = 16000",
                "",
                "[[transcription_workflows]]",
                'workflow_id = "canary-nemo"',
                'workflow_label = "canary-nemo"',
                'model = "nvidia/canary-1b-v2"',
                'vad_model = "nvidia/Frame_VAD_Multilingual_MarbleNet_v2.0"',
                'strategy = "greedy"',
                "",
                "[[transcription_workflows]]",
                'workflow_id = "canary-nemo-beam"',
                'workflow_label = "canary-nemo"',
                'model = "nvidia/canary-1b-v2"',
                'vad_model = "nvidia/Frame_VAD_Multilingual_MarbleNet_v2.0"',
                'strategy = "beam"',
                'align_model = "comodoro/wav2vec2-xls-r-300m-cs-250"',
                "",
                "[[transcription_workflows]]",
                'workflow_id = "faster-whisper"',
                'workflow_label = "faster-whisper"',
                'model = "large-v3"',
                'vad_model = "silero_vad_v6"',
                "",
                "[[transcription_workflows]]",
                'workflow_id = "whisperx"',
                'workflow_label = "whisperx"',
                'model = "large-v3"',
                'vad_model = "silero"',
                'align_model = "comodoro/wav2vec2-xls-r-300m-cs-250"',
                "",
                "[vad]",
                "min_silence_ms = 500",
                "filter_enabled = true",
                "word_timestamps = true",
                "",
                "[diarization]",
                "min_speakers = 2",
                "max_speakers = 10",
                "spectral_p_value = 0.22",
                "",
                "[analysis]",
                "cross_model_limit = 10",
                "sample_files = 100",
                "sample_hashes = 10",
                "max_words_per_file = 500",
                "",
                "[nemo]",
                "min_silence_duration = 0.1",
                "precision = 3",
                "",
            ]
        ),
        encoding="utf-8",
    )

    env = os.environ.copy()
    env["BESEDY_CONFIG"] = str(config_path)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "besedy.cli.analyze",
            "validate",
            "--format",
            "json",
            "--limit",
            "1",
        ],
        capture_output=True,
        text=True,
        cwd=Path.cwd(),
        env=env,
        timeout=60,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"

    payload = json.loads(result.stdout)
    assert payload["name"] == "validate"
    assert payload["status"] == "success"
    assert "result" in payload
