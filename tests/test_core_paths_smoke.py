"""Smoke tests for besedy/core/paths.py utilities."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from besedy.config.settings import get_config, resolve_config_path, set_config
from besedy.core.paths import (
    BESEDY_ROOT,
    PROJECT_ROOT,
    extract_run_id_from_transcripts_root,
    extract_timestamp_from_catalog,
    extract_timestamp_from_normalized_catalog,
    extract_timestamp_from_transcripts_root,
    hash_component_from_sha,
    iter_transcript_paths,
    parse_transcript_components,
    require_valid_hash_stem,
    resolve_audio_artifacts_root,
    resolve_config_home,
    resolve_logs_dir,
    resolve_models_dir,
    resolve_project_path,
    resolve_share_home,
    resolve_state_home,
    resolve_tmp_dir,
    resolve_transcripts_parquet_parent,
    resolve_transcripts_root,
    resolve_web_env_path,
    sanitize_component,
)


class TestProjectPaths:
    """Verify base paths exist and are configured correctly."""

    def test_project_root_exists(self):
        assert PROJECT_ROOT.exists()
        assert PROJECT_ROOT.is_dir()

    def test_besedy_root_is_package(self):
        assert BESEDY_ROOT.exists()
        assert (BESEDY_ROOT / "__init__.py").exists()

    def test_besedy_root_is_under_project_root(self):
        assert BESEDY_ROOT.parent == PROJECT_ROOT


class TestResolveProjectPath:
    """Tests for resolve_project_path()."""

    def test_relative_path_is_resolved(self):
        result = resolve_project_path("tests")
        assert result == PROJECT_ROOT / "tests"

    def test_absolute_path_unchanged(self, tmp_path):
        result = resolve_project_path(tmp_path)
        assert result == tmp_path

    def test_string_input_works(self):
        result = resolve_project_path("besedy")
        assert result == PROJECT_ROOT / "besedy"


class TestHomeRuntimeRoots:
    """Tests for XDG/home runtime path helpers."""

    def test_config_home_uses_xdg_config_root(self, monkeypatch, tmp_path):
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))
        assert resolve_config_home() == tmp_path / "xdg-config" / "lukleh" / "besedy"

    def test_resolve_config_path_ignores_besedy_config_home(self, monkeypatch, tmp_path):
        monkeypatch.delenv("BESEDY_CONFIG", raising=False)
        monkeypatch.setenv("BESEDY_CONFIG_HOME", str(tmp_path / "ignored-config-home"))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))

        ignored_path = tmp_path / "ignored-config-home" / "besedy.toml"
        ignored_path.parent.mkdir(parents=True)
        ignored_path.write_text("", encoding="utf-8")

        canonical_path = tmp_path / "xdg-config" / "lukleh" / "besedy" / "besedy.toml"
        canonical_path.parent.mkdir(parents=True)
        canonical_path.write_text("", encoding="utf-8")

        assert resolve_config_path() == canonical_path

    def test_share_home_uses_xdg_data_root(self, monkeypatch, tmp_path):
        monkeypatch.delenv("BESEDY_SHARE_HOME", raising=False)
        monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg-data"))
        assert resolve_share_home() == tmp_path / "xdg-data" / "lukleh" / "besedy"

    def test_state_and_child_dirs_use_xdg_state_root(self, monkeypatch, tmp_path):
        monkeypatch.delenv("BESEDY_STATE_HOME", raising=False)
        monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "xdg-state"))
        expected_root = tmp_path / "xdg-state" / "lukleh" / "besedy"
        assert resolve_state_home() == expected_root
        assert resolve_logs_dir() == expected_root / "logs"
        assert resolve_tmp_dir() == expected_root / "tmp"

    def test_models_dir_prefers_home_copy_once_it_exists(self, monkeypatch, tmp_path):
        monkeypatch.setenv("BESEDY_SHARE_HOME", str(tmp_path / "share-home"))
        home_models_dir = tmp_path / "share-home" / "models"
        home_models_dir.mkdir(parents=True)
        assert resolve_models_dir() == home_models_dir

    def test_web_env_path_honors_explicit_override(self, monkeypatch, tmp_path):
        env_file = tmp_path / "web.env.prod"
        env_file.write_text(
            "RAG_BACKEND_KEY=faster-whisper/large-v3@silero_vad_v6\n", encoding="utf-8"
        )
        monkeypatch.setenv("BESEDY_WEB_ENV_PROD", str(env_file))
        assert resolve_web_env_path("production") == env_file

    def test_web_env_path_override_is_authoritative(self, monkeypatch, tmp_path):
        override_path = tmp_path / "override.env"
        canonical_path = tmp_path / "xdg-config" / "lukleh" / "besedy" / "web.env.prod"
        canonical_path.parent.mkdir(parents=True)
        canonical_path.write_text(
            "RAG_BACKEND_KEY=faster-whisper/large-v3@silero_vad_v6\n", encoding="utf-8"
        )

        monkeypatch.setenv("BESEDY_WEB_ENV_PROD", str(override_path))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))

        with pytest.raises(FileNotFoundError, match="BESEDY_WEB_ENV_PROD points to missing file"):
            resolve_web_env_path("production")


class TestResolveAudioArtifactsRoot:
    """Tests for resolve_audio_artifacts_root()."""

    def test_default_is_project_root(self, monkeypatch):
        monkeypatch.delenv("BESEDY_AUDIO_ARTIFACTS_ROOT", raising=False)
        original = get_config()
        try:
            set_config(
                replace(
                    original,
                    paths=replace(original.paths, audio_artifacts_dir=""),
                )
            )
            assert resolve_audio_artifacts_root() == PROJECT_ROOT
        finally:
            set_config(original)

    def test_reads_from_config(self, monkeypatch, tmp_path):
        monkeypatch.delenv("BESEDY_AUDIO_ARTIFACTS_ROOT", raising=False)
        original = get_config()
        try:
            set_config(
                replace(
                    original,
                    paths=replace(original.paths, audio_artifacts_dir=str(tmp_path)),
                )
            )
            assert resolve_audio_artifacts_root() == tmp_path
        finally:
            set_config(original)

    def test_relative_path_resolves_under_project_root_from_config(self, monkeypatch):
        monkeypatch.delenv("BESEDY_AUDIO_ARTIFACTS_ROOT", raising=False)
        original = get_config()
        try:
            set_config(
                replace(
                    original,
                    paths=replace(original.paths, audio_artifacts_dir="tmp/audio_artifacts"),
                )
            )
            assert resolve_audio_artifacts_root() == PROJECT_ROOT / "tmp/audio_artifacts"
        finally:
            set_config(original)

    def test_env_var_overrides_config(self, monkeypatch, tmp_path):
        original = get_config()
        try:
            set_config(
                replace(
                    original,
                    paths=replace(original.paths, audio_artifacts_dir="tmp/audio_artifacts"),
                )
            )
            monkeypatch.setenv("BESEDY_AUDIO_ARTIFACTS_ROOT", str(tmp_path))
            assert resolve_audio_artifacts_root() == tmp_path
        finally:
            set_config(original)


class TestResolveTranscriptsRoot:
    """Tests for resolve_transcripts_root()."""

    def test_none_returns_configured_text_data_dir(self, monkeypatch, tmp_path):
        monkeypatch.delenv("BESEDY_TEXT_DATA_ROOT", raising=False)
        original = get_config()
        try:
            set_config(
                replace(original, paths=replace(original.paths, text_data_dir=str(tmp_path)))
            )
            result = resolve_transcripts_root(None)
            assert result == tmp_path / "transcripts"
        finally:
            set_config(original)

    def test_empty_string_returns_configured_text_data_dir(self, monkeypatch, tmp_path):
        monkeypatch.delenv("BESEDY_TEXT_DATA_ROOT", raising=False)
        original = get_config()
        try:
            set_config(
                replace(original, paths=replace(original.paths, text_data_dir=str(tmp_path)))
            )
            result = resolve_transcripts_root("")
            assert result == tmp_path / "transcripts"
        finally:
            set_config(original)

    def test_relative_path_resolved(self):
        result = resolve_transcripts_root("transcripts_20251128_120000")
        assert result == PROJECT_ROOT / "transcripts_20251128_120000"


class TestResolveTranscriptsParquetParent:
    """Tests for resolve_transcripts_parquet_parent()."""

    def test_raises_when_no_text_data_dir(self, monkeypatch):
        """text_data_dir is required when resolving parquet outputs."""
        monkeypatch.delenv("BESEDY_TEXT_DATA_ROOT", raising=False)
        original = get_config()
        try:
            set_config(
                replace(
                    original,
                    paths=replace(original.paths, text_data_dir=""),
                )
            )
            with pytest.raises(RuntimeError):
                resolve_transcripts_parquet_parent()
        finally:
            set_config(original)

    def test_returns_transcripts_parquet_subdir_when_text_data_dir_configured(
        self, monkeypatch, tmp_path
    ):
        """When text_data_dir is configured, returns text_data_dir/transcripts_parquet/."""
        monkeypatch.delenv("BESEDY_TEXT_DATA_ROOT", raising=False)
        original = get_config()
        try:
            set_config(
                replace(
                    original,
                    paths=replace(original.paths, text_data_dir=str(tmp_path)),
                )
            )
            result = resolve_transcripts_parquet_parent()
            expected = tmp_path / "transcripts_parquet"
            assert result == expected
            # Should also create the directory
            assert result.exists()
            assert result.is_dir()
        finally:
            set_config(original)


class TestHashComponentFromSha:
    """Tests for hash_component_from_sha()."""

    def test_lowercase_conversion(self):
        result = hash_component_from_sha("ABC123DEF")
        assert result == "abc123def"

    def test_whitespace_stripped(self):
        result = hash_component_from_sha("  abc123  ")
        assert result == "abc123"

    def test_safe_characters_preserved(self):
        result = hash_component_from_sha("abc-123_def.456")
        assert result == "abc-123_def.456"


class TestSanitizeComponent:
    """Tests for sanitize_component()."""

    def test_alphanumeric_preserved(self):
        result = sanitize_component("abc123")
        assert result == "abc123"

    def test_special_chars_replaced(self):
        result = sanitize_component("hello world!")
        assert " " not in result
        assert "!" not in result

    def test_leading_trailing_stripped(self):
        result = sanitize_component("  test  ")
        assert not result.startswith("_")
        assert not result.endswith("_")


class TestTimestampExtraction:
    """Tests for timestamp extraction functions."""

    def test_extract_from_catalog(self):
        path = Path("audio_catalog_20251128_120000.csv")
        result = extract_timestamp_from_catalog(path)
        assert result == "20251128_120000"

    def test_extract_from_catalog_no_match(self):
        path = Path("some_other_file.csv")
        result = extract_timestamp_from_catalog(path)
        assert result is None

    def test_extract_from_normalized_catalog(self):
        path = Path("audio_catalog_20251128_120000_normalized.csv")
        result = extract_timestamp_from_normalized_catalog(path)
        assert result == "20251128_120000"

    def test_extract_from_transcripts_root(self):
        path = Path("transcripts_20251128_120000")
        result = extract_timestamp_from_transcripts_root(path)
        assert result == "20251128_120000"

    def test_extract_from_transcripts_root_with_variant(self):
        path = Path("transcripts_20251128_120000_dfn3-v1")
        assert extract_timestamp_from_transcripts_root(path) == "20251128_120000"
        assert extract_run_id_from_transcripts_root(path) == "20251128_120000_dfn3-v1"

    def test_extract_from_enhanced_transcripts_root(self):
        path = Path("transcripts_enhanced_20251128_120000_dfn3-v1")
        assert extract_timestamp_from_transcripts_root(path) == "20251128_120000"
        assert extract_run_id_from_transcripts_root(path) == "20251128_120000_dfn3-v1"

    def test_extract_handles_trailing_slash(self):
        path = Path("transcripts_20251128_120000/")
        result = extract_timestamp_from_transcripts_root(path)
        assert result == "20251128_120000"


class TestIterTranscriptPaths:
    """Tests for iter_transcript_paths()."""

    def test_finds_transcript_json(self, tmp_path):
        # Create structure: workflow/model/hash/transcript.json
        transcript_dir = tmp_path / "faster-whisper" / "large-v3" / "abc123"
        transcript_dir.mkdir(parents=True)
        transcript_file = transcript_dir / "transcript.json"
        transcript_file.write_text('{"segments": []}')

        paths = list(iter_transcript_paths(tmp_path))
        assert len(paths) == 1
        assert paths[0] == transcript_file

    def test_ignores_transcript_original_json(self, tmp_path):
        transcript_dir = tmp_path / "whisperx" / "large-v3" / "def456"
        transcript_dir.mkdir(parents=True)
        original_file = transcript_dir / "transcript_original.json"
        original_file.write_text('{"segments": []}')

        paths = list(iter_transcript_paths(tmp_path))
        assert paths == []

    def test_empty_directory(self, tmp_path):
        paths = list(iter_transcript_paths(tmp_path))
        assert paths == []


class TestParseTranscriptComponents:
    """Tests for parse_transcript_components()."""

    def test_extracts_workflow_model_hash(self, tmp_path):
        transcript_path = tmp_path / "faster-whisper" / "large-v3" / "abc123def" / "transcript.json"
        transcript_path.parent.mkdir(parents=True)
        transcript_path.touch()

        result = parse_transcript_components(transcript_path, tmp_path)
        assert result is not None
        workflow, model, audio_hash = result
        assert workflow == "faster-whisper"
        assert model == "large-v3"
        assert audio_hash == "abc123def"

    def test_returns_none_for_shallow_path(self, tmp_path):
        # Path too shallow (fewer than 4 parts)
        transcript_path = tmp_path / "transcript.json"
        result = parse_transcript_components(transcript_path, tmp_path)
        assert result is None

    def test_returns_none_for_unrelated_path(self, tmp_path):
        other_path = Path("/some/other/location/transcript.json")
        result = parse_transcript_components(other_path, tmp_path)
        assert result is None


class TestRequireValidHashStem:
    """Tests for require_valid_hash_stem()."""

    def test_valid_64_char_hash(self, tmp_path):
        valid_hash = "a" * 64
        audio_path = tmp_path / f"{valid_hash}.wav"
        result = require_valid_hash_stem(audio_path)
        assert result == valid_hash

    def test_valid_mixed_hex_hash(self, tmp_path):
        valid_hash = "0123456789abcdef" * 4  # 64 chars
        audio_path = tmp_path / f"{valid_hash}.wav"
        result = require_valid_hash_stem(audio_path)
        assert result == valid_hash

    def test_uppercase_converted_to_lowercase(self, tmp_path):
        uppercase_hash = "ABCDEF0123456789" * 4  # 64 chars
        audio_path = tmp_path / f"{uppercase_hash}.wav"
        result = require_valid_hash_stem(audio_path)
        assert result == uppercase_hash.lower()

    def test_rejects_short_stem(self, tmp_path):
        audio_path = tmp_path / "abc123.wav"
        with pytest.raises(ValueError) as exc_info:
            require_valid_hash_stem(audio_path)
        assert "expected 64-character SHA-256 hash" in str(exc_info.value)
        assert "6 chars" in str(exc_info.value)

    def test_rejects_non_hex_characters(self, tmp_path):
        # 64 chars but includes 'g' which is not hex
        invalid_hash = "g" + "a" * 63
        audio_path = tmp_path / f"{invalid_hash}.wav"
        with pytest.raises(ValueError) as exc_info:
            require_valid_hash_stem(audio_path)
        assert "expected 64-character SHA-256 hash" in str(exc_info.value)

    def test_rejects_descriptive_filename(self, tmp_path):
        audio_path = tmp_path / "my-audio-file.wav"
        with pytest.raises(ValueError) as exc_info:
            require_valid_hash_stem(audio_path)
        assert "stage-audio" in str(exc_info.value)  # Helpful hint in error

    def test_error_message_includes_guidance(self, tmp_path):
        audio_path = tmp_path / "recording.wav"
        with pytest.raises(ValueError) as exc_info:
            require_valid_hash_stem(audio_path)
        error_msg = str(exc_info.value)
        assert "catalog stage-audio" in error_msg
        assert "content hash" not in error_msg or "hash" in error_msg
