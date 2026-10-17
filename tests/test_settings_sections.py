"""Only supported configuration sections belong in the active configuration."""

from pathlib import Path

import pytest

from besedy.config import settings


def test_example_loads_without_retired_sections(tmp_path, monkeypatch):
    example = Path(__file__).resolve().parents[1] / "besedy.toml.example"
    config_path = tmp_path / "besedy.toml"
    config_path.write_text(example.read_text())
    monkeypatch.setattr(settings, "resolve_config_path", lambda: config_path)

    loaded = settings._load_config()

    assert loaded.audio.sample_rate == 16000
    assert loaded.transcription_workflows


@pytest.mark.parametrize("section", ["diarization", "analysis", "unknown"])
def test_config_rejects_unsupported_sections(tmp_path, monkeypatch, section):
    example = Path(__file__).resolve().parents[1] / "besedy.toml.example"
    config_path = tmp_path / "besedy.toml"
    config_path.write_text(example.read_text() + f"\n[{section}]\n")
    monkeypatch.setattr(settings, "resolve_config_path", lambda: config_path)

    with pytest.raises(ValueError, match=rf"Unsupported configuration sections: \[{section}\]"):
        settings._load_config()
