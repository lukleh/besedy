"""Only supported configuration sections belong in the active configuration."""

from pathlib import Path

import pytest

from besedy.config import settings
from besedy.core import paths_runtime


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


@pytest.mark.parametrize(
    ("resolver", "env"),
    [
        (paths_runtime.resolve_text_data_root, {}),
        (paths_runtime.resolve_corrections_root, {"BESEDY_TEXT_DATA_ROOT": "/data/text"}),
        (paths_runtime.resolve_original_audio_root, {}),
    ],
)
def test_path_resolvers_report_unsupported_sections(tmp_path, monkeypatch, resolver, env):
    # Only a missing besedy.toml falls back to defaults or a "root is required"
    # message; a rejected configuration must surface its own error.
    example = Path(__file__).resolve().parents[1] / "besedy.toml.example"
    config_path = tmp_path / "besedy.toml"
    config_path.write_text(example.read_text() + "\n[diarization]\n")
    monkeypatch.setenv("BESEDY_CONFIG", str(config_path))
    monkeypatch.delenv("BESEDY_TEXT_DATA_ROOT", raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(settings, "_CONFIG", None)

    with pytest.raises(ValueError, match=r"Unsupported configuration sections: \[diarization\]"):
        resolver()
