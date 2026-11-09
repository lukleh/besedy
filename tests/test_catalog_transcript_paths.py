"""The pipeline, host worker and web reader agree on catalog generations."""

import json
import tomllib
from pathlib import Path

import pytest

from besedy.config import settings
from besedy.core.paths import (
    catalog_transcripts_dirname,
    resolve_transcripts_parent,
    resolve_transcripts_root,
)

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[1] / "contracts/catalog-transcript-paths.json").read_text()
)


@pytest.mark.parametrize("case", CONTRACT["generations"])
def test_catalog_generation_matches_web_contract(case):
    assert catalog_transcripts_dirname(case["catalogId"]) == case["directory"]


@pytest.mark.parametrize("catalog_id", CONTRACT["invalidCatalogIds"])
def test_invalid_catalog_generation_is_refused(catalog_id):
    with pytest.raises(ValueError, match="catalog ID"):
        catalog_transcripts_dirname(catalog_id)


def test_transcript_parent_matches_web_contract(tmp_path, monkeypatch):
    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))
    assert resolve_transcripts_parent() == tmp_path / CONTRACT["parent"]


def _configure_text_paths(tmp_path, monkeypatch, parent):
    text_root = tmp_path / "text"
    content = (Path(__file__).resolve().parents[1] / "besedy.toml.example").read_text()
    content = content.replace('text_data_dir = ""', f"text_data_dir = {json.dumps(str(text_root))}")
    replacement = "" if parent is None else f"transcripts_dir = {json.dumps(parent)}\n"
    content = content.replace('transcripts_dir = "transcripts"\n', replacement)
    config_path = tmp_path / "besedy.toml"
    config_path.write_text(content)
    monkeypatch.setenv("BESEDY_CONFIG", str(config_path))
    monkeypatch.delenv("BESEDY_TEXT_DATA_ROOT", raising=False)
    monkeypatch.setattr(settings, "_CONFIG", None)
    return text_root


@pytest.mark.parametrize("parent", [None, ""])
def test_omitted_or_empty_parent_keeps_the_default(tmp_path, monkeypatch, parent):
    text_root = _configure_text_paths(tmp_path, monkeypatch, parent)
    assert resolve_transcripts_parent() == text_root / CONTRACT["parent"]


@pytest.mark.parametrize("parent", CONTRACT["customParents"])
def test_custom_parent_keeps_artifacts_and_latest_generation_semantics(
    tmp_path, monkeypatch, parent
):
    text_root = _configure_text_paths(tmp_path, monkeypatch, parent["configured"])
    transcripts_parent = text_root / parent["relative"]
    bound = transcripts_parent / catalog_transcripts_dirname("20251225_120000")
    artifact = bound / "faster-whisper/model@lang-cs" / ("a" * 64) / "transcript.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text('{"segments": []}')
    latest = transcripts_parent / catalog_transcripts_dirname("20261108_230000")
    latest.mkdir()
    (transcripts_parent / "transcripts").symlink_to(latest, target_is_directory=True)

    assert resolve_transcripts_parent() == transcripts_parent
    assert (
        resolve_transcripts_parent() / bound.name / artifact.relative_to(bound)
    ).read_text() == artifact.read_text()
    assert resolve_transcripts_root() == latest.resolve()
    assert resolve_transcripts_root(transcripts_parent) == latest.resolve()
    assert resolve_transcripts_root(bound) == bound


def test_text_root_environment_and_explicit_root_keep_their_precedence(tmp_path, monkeypatch):
    _configure_text_paths(tmp_path, monkeypatch, "custom-transcripts")
    override = tmp_path / "override"
    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(override))
    assert resolve_transcripts_parent() == override / "custom-transcripts"
    explicit = tmp_path / "explicit"
    assert resolve_transcripts_root(explicit) == explicit


def test_text_root_override_without_a_config_keeps_the_default_parent(tmp_path, monkeypatch):
    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("BESEDY_CONFIG", str(tmp_path / "missing.toml"))
    monkeypatch.setattr(settings, "_CONFIG", None)
    assert resolve_transcripts_parent() == tmp_path / CONTRACT["parent"]


@pytest.mark.parametrize("config_override", [None, "", "   "])
@pytest.mark.parametrize("content", ["[paths\n", '[paths]\ntranscripts_dir = "custom"\n'])
def test_environment_only_root_ignores_invalid_discovered_config(
    tmp_path, monkeypatch, config_override, content
):
    host_config = tmp_path / "host-config"
    host_config.mkdir()
    (host_config / "besedy.toml").write_text(content)
    monkeypatch.setattr(settings, "_resolve_preferred_config_home", lambda: host_config)
    monkeypatch.setattr(settings, "_CONFIG", None)
    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path / "text"))
    if config_override is None:
        monkeypatch.delenv("BESEDY_CONFIG", raising=False)
    else:
        monkeypatch.setenv("BESEDY_CONFIG", config_override)

    expected = tmp_path / "text" / CONTRACT["parent"]
    assert resolve_transcripts_parent() == expected
    assert resolve_transcripts_root() == expected
    assert settings._CONFIG is None


def test_environment_only_root_ignores_custom_parent_in_discovered_config(tmp_path, monkeypatch):
    _configure_text_paths(tmp_path, monkeypatch, "custom-transcripts")
    monkeypatch.setattr(settings, "_resolve_preferred_config_home", lambda: tmp_path)
    monkeypatch.delenv("BESEDY_CONFIG")
    override = tmp_path / "override"
    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(override))

    assert resolve_transcripts_parent() == override / CONTRACT["parent"]
    assert settings._CONFIG is None


@pytest.mark.parametrize(
    ("content", "error"),
    [("[paths\n", tomllib.TOMLDecodeError), ('[paths]\ntranscripts_dir = "custom"\n', KeyError)],
)
def test_environment_root_keeps_explicit_config_errors(tmp_path, monkeypatch, content, error):
    config_path = tmp_path / "besedy.toml"
    config_path.write_text(content)
    monkeypatch.setenv("BESEDY_CONFIG", str(config_path))
    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path / "override"))
    monkeypatch.setattr(settings, "_CONFIG", None)

    with pytest.raises(error):
        resolve_transcripts_parent()
