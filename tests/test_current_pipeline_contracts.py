"""Current-only boundaries reject old inputs without rewriting valuable files."""

import argparse

import pytest

from besedy.commands.catalog.duplicates import parse_hash_sidecar_file
from besedy.commands.catalog.extract import _discover_transcripts
from besedy.lib.catalog.manager import (
    AUDIO_HASH_ALGORITHM,
    catalog_fieldnames,
    require_catalog_schema,
    source_file_sha256,
    write_audio_hash_sidecar,
)
from besedy.workflows import align_nemo_with_whisperx


def test_check_uses_only_the_current_normalized_filename(tmp_path, monkeypatch):
    from besedy.commands.catalog import check

    timestamp = "20260101_120000"
    catalog = tmp_path / f"audio_catalog_{timestamp}.csv"
    catalog.touch()
    (tmp_path / f"audio_catalog_{timestamp}_normalized.csv").touch()
    (tmp_path / f"transcripts_{timestamp}").mkdir()
    monkeypatch.setattr(check, "resolve_transcripts_parent", lambda: tmp_path)
    args = argparse.Namespace(csv_normalized=tmp_path / "audio_catalog_normalized.csv")
    current = tmp_path / f"audio_catalog_{timestamp}_loudness_normalized.csv"

    incomplete = check._resolve_timestamped_inputs(args, catalog, timestamp)
    assert isinstance(incomplete, check._IncompletePipeline)
    assert incomplete.normalized_path == current

    current.touch()
    resolved = check._resolve_timestamped_inputs(args, catalog, timestamp)
    assert isinstance(resolved, check._CheckInputs)
    assert resolved.csv_normalized_path == current


def test_catalog_requires_current_headers_and_recorded_timestamps(tmp_path):
    path = tmp_path / "catalog.csv"
    columns = catalog_fieldnames()
    row = {
        "Hash": "a" * 64,
        "Hash Algorithm": AUDIO_HASH_ALGORITHM,
        "Full Path": "/audio/a.wav",
        "added_at": "2026-01-01T00:00:00Z",
    }
    require_catalog_schema(columns, [row], path=path)
    with pytest.raises(ValueError, match="added_at"):
        require_catalog_schema(
            [column for column in columns if column != "added_at"], [row], path=path
        )
    with pytest.raises(ValueError, match="added_at"):
        require_catalog_schema(columns, [{**row, "added_at": ""}], path=path)
    with pytest.raises(ValueError, match="unexpected.*old_field"):
        require_catalog_schema([*columns, "old_field"], [row], path=path)


def test_export_ignores_retired_names_and_path_layouts(tmp_path):
    for model, audio_hash, filename in [
        ("large-v3@lang-cs", "a" * 64, "transcript.json"),
        ("large-v3@lang-cs", "b" * 64, "transcript_original.json"),
        ("large-v3", "c" * 64, "transcript.json"),
        ("large-v3@lang-cs", "abc123", "transcript.json"),
    ]:
        path = tmp_path / "faster-whisper" / model / audio_hash / filename
        path.parent.mkdir(parents=True)
        path.write_text("{}")
    assert list(_discover_transcripts(tmp_path, None, None)) == [
        ("faster-whisper", "large-v3@lang-cs", "a" * 64)
    ]


def test_duplicate_detection_requires_current_fresh_sidecar(tmp_path):
    source = tmp_path / "a.wav"
    source.write_bytes(b"original audio")
    sidecar = tmp_path / "a.wav.audiohash"
    sidecar.write_text("a" * 64 + "  a.wav\n")
    assert parse_hash_sidecar_file(sidecar) is None
    write_audio_hash_sidecar(
        sidecar,
        hash_value="a" * 64,
        filename=source.name,
        source_file_sha256=source_file_sha256(source),
    )
    assert parse_hash_sidecar_file(sidecar) == ("a" * 64, source)
    source.write_bytes(b"changed audio")
    assert parse_hash_sidecar_file(sidecar) is None


def test_alignment_uses_the_canonical_root_resolver(monkeypatch):
    def invalid_config():
        raise ValueError("invalid current configuration")

    monkeypatch.setattr(align_nemo_with_whisperx, "resolve_transcripts_root", invalid_config)
    with pytest.raises(ValueError, match="invalid current configuration"):
        align_nemo_with_whisperx._default_transcripts_root()
