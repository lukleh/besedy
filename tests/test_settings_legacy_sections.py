"""Retired configuration sections must not be required by active commands."""

from pathlib import Path

import pytest

from besedy.config import settings


@pytest.mark.parametrize(
    "legacy_sections",
    [
        "",
        "[diarization]\nmin_speakers = 2\n",
        "[analysis]\nsample_files = 100\n",
        "[diarization]\nmin_speakers = 2\n[analysis]\nsample_files = 100\n",
    ],
)
def test_config_accepts_missing_or_legacy_unused_sections(tmp_path, monkeypatch, legacy_sections):
    example = Path(__file__).resolve().parents[1] / "besedy.toml.example"
    config_path = tmp_path / "besedy.toml"
    config_path.write_text(example.read_text() + "\n" + legacy_sections)
    monkeypatch.setattr(settings, "resolve_config_path", lambda: config_path)

    loaded = settings._load_config()

    assert loaded.audio.sample_rate == 16000
    assert loaded.transcription_workflows
