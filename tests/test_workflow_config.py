"""Tests for lib/workflow/config.py, paths.py, and vram.py modules."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import besedy.config.settings as config_settings
from besedy.lib.workflow.config import (
    WorkflowConfig,
    get_diarization_workflows,
    get_transcription_workflows,
    get_workflow_config,
    list_workflow_ids,
    select_transcription_workflow,
)
from besedy.lib.workflow.paths import (
    WorkflowPathBuilder,
    artifact_exists,
    artifact_path,
    path_builder,
    sanitize_component,
    sanitize_model_identifier,
    transcripts_dir,
)
from besedy.lib.workflow.vram import (
    calculate_parallel_instances,
    get_available_vram_gb,
)
from tests.helpers.workflows import make_workflow_config


class TestWorkflowConfig:
    """Tests for WorkflowConfig dataclass and registry."""

    def test_workflow_config_is_frozen(self):
        """WorkflowConfig should be immutable."""
        config = get_workflow_config("faster-whisper")
        with pytest.raises(AttributeError):
            config.model_name = "different-model"

    def test_get_workflow_config_valid_ids(self):
        """get_workflow_config returns config for all registered IDs."""
        for workflow_id in list_workflow_ids():
            config = get_workflow_config(workflow_id)
            assert isinstance(config, WorkflowConfig)
            assert config.workflow_id == workflow_id

    def test_get_workflow_config_unknown_id(self):
        """get_workflow_config raises KeyError with helpful message for unknown IDs."""
        with pytest.raises(KeyError) as exc_info:
            get_workflow_config("nonexistent-workflow")

        error_msg = str(exc_info.value)
        assert "nonexistent-workflow" in error_msg
        assert "Available workflows" in error_msg
        # Should list at least some known workflows
        assert "faster-whisper" in error_msg

    def test_list_workflow_ids_returns_all(self):
        """list_workflow_ids returns all registered workflow IDs."""
        ids = list_workflow_ids()
        assert "faster-whisper" in ids
        assert "canary-nemo" in ids
        assert "canary-nemo-beam" in ids
        assert "whisperx" in ids
        assert "pyannote" in ids
        assert "speechbrain" not in ids

    def test_get_transcription_workflows(self):
        """get_transcription_workflows returns only transcription configs."""
        configs = get_transcription_workflows()
        assert len(configs) >= 3  # faster-whisper, canary-nemo, whisperx
        for config in configs:
            assert config.workflow_type == "transcription"

    def test_get_diarization_workflows(self):
        """get_diarization_workflows returns only diarization configs."""
        configs = get_diarization_workflows()
        assert len(configs) >= 1  # pyannote (speechbrain removed)
        for config in configs:
            assert config.workflow_type == "diarization"

    def test_output_component_with_vad(self):
        """output_component returns model@vad format when VAD is specified."""
        config = get_workflow_config("faster-whisper")
        component = config.output_component(sanitize_model_identifier)
        assert "@" in component
        assert "large" in component.lower()

    def test_output_component_without_vad(self):
        """output_component returns model-only format for diarization."""
        config = get_workflow_config("pyannote")
        component = config.output_component(sanitize_model_identifier)
        assert "@" not in component
        assert "pyannote" in component.lower()

    def test_output_component_for_auto_language_whisperx(self, monkeypatch):
        """Auto-language WhisperX uses upstream alignment-model selection."""
        example_config = Path(__file__).parents[1] / "besedy.toml.example"
        monkeypatch.setenv("BESEDY_CONFIG", str(example_config))
        monkeypatch.setattr(config_settings, "_CONFIG", None)

        automatic = get_transcription_workflows(
            workflow_id="whisperx",
            language="auto",
        )
        assert len(automatic) == 1

        config = get_workflow_config("whisperx")
        assert config == automatic[0]
        assert config.language == "auto"
        assert config.align_model is None
        component = config.output_component(sanitize_model_identifier)
        assert component == "large-v3@silero@lang-auto"

    def test_output_component_preserves_legacy_czech_path_and_identifies_other_languages(
        self,
    ):
        czech = make_workflow_config(vad_model="silero", language="cs")
        czech_aligned = make_workflow_config(
            vad_model="silero", language="cs", align_model="czech-aligner"
        )
        automatic = make_workflow_config(vad_model="silero", language="auto")
        english = make_workflow_config(vad_model="silero", language="en")

        assert czech.output_component(sanitize_model_identifier) == "large-v3@silero"
        assert (
            czech_aligned.output_component(sanitize_model_identifier)
            == "large-v3@silero@czech-aligner"
        )
        assert automatic.output_component(sanitize_model_identifier) == "large-v3@silero@lang-auto"
        assert english.output_component(sanitize_model_identifier) == "large-v3@silero@lang-en"

    def test_select_transcription_workflow_warns_on_unmatched_filters(self, capsys, monkeypatch):
        """CLI overrides that match no configured variant fall back loudly."""
        configured = make_workflow_config(language="cs")
        monkeypatch.setattr(
            "besedy.lib.workflow.config.get_transcription_workflows",
            lambda **kwargs: [] if kwargs.get("language") else [configured],
        )

        selected = select_transcription_workflow("faster-whisper", language="de")

        assert selected == configured
        assert "no configured faster-whisper variant matches" in capsys.readouterr().err

    def test_select_transcription_workflow_warning_names_the_inherited_variant(
        self, capsys, monkeypatch
    ):
        """The fallback warning names the variant actually returned, not the first listed."""
        secondary = make_workflow_config(model_name="small", pipeline_default=False)
        primary = make_workflow_config(model_name="large-v3")
        monkeypatch.setattr(
            "besedy.lib.workflow.config.get_transcription_workflows",
            lambda **kwargs: [] if kwargs.get("language") else [secondary, primary],
        )

        selected = select_transcription_workflow("faster-whisper", language="de")

        assert selected == primary
        assert "using defaults from the large-v3 entry" in capsys.readouterr().err


class TestSanitizeFunctions:
    """Tests for path sanitization functions."""

    def test_sanitize_component_basic(self):
        """sanitize_component removes unsafe characters."""
        assert sanitize_component("hello world") == "hello_world"
        assert sanitize_component("test/path") == "test_path"
        assert sanitize_component("name:value") == "name_value"

    def test_sanitize_component_preserves_safe_chars(self):
        """sanitize_component preserves alphanumerics, dots, dashes, underscores."""
        assert sanitize_component("model-v1.0_final") == "model-v1.0_final"
        assert sanitize_component("abc123") == "abc123"

    def test_sanitize_component_strips_leading_trailing(self):
        """sanitize_component strips leading/trailing underscores."""
        assert sanitize_component("  test  ") == "test"
        assert sanitize_component("__test__") == "test"

    def test_sanitize_model_identifier_nvidia_path(self):
        """sanitize_model_identifier handles nvidia/model paths."""
        result = sanitize_model_identifier("nvidia/canary-1b-v2")
        assert "/" not in result
        assert result.islower()
        assert "nvidia" in result
        assert "canary" in result

    def test_sanitize_model_identifier_nemo_file(self):
        """sanitize_model_identifier handles .nemo file paths."""
        result = sanitize_model_identifier("/path/to/model.nemo")
        assert result == "model"

    def test_sanitize_model_identifier_dots_replaced(self):
        """sanitize_model_identifier replaces dots with underscores."""
        result = sanitize_model_identifier("model.v1.0")
        assert "." not in result
        assert "model" in result


class TestWorkflowPathBuilder:
    """Tests for WorkflowPathBuilder class."""

    @pytest.fixture
    def tmp_project(self, tmp_path, monkeypatch):
        """Create a temporary project structure with isolated config."""
        (tmp_path / "transcripts").mkdir()
        from besedy.config.settings import config

        monkeypatch.setattr(config.paths, "text_data_dir", str(tmp_path))
        return tmp_path

    def test_path_builder_factory(self):
        """path_builder factory creates WorkflowPathBuilder."""
        pb = path_builder("faster-whisper")
        assert isinstance(pb, WorkflowPathBuilder)
        assert pb.config.workflow_id == "faster-whisper"

    def test_path_builder_invalid_workflow(self):
        """path_builder raises KeyError for invalid workflow."""
        with pytest.raises(KeyError) as exc_info:
            path_builder("invalid-workflow")
        assert "invalid-workflow" in str(exc_info.value)

    def test_output_component(self):
        """output_component returns expected format."""
        pb = path_builder("faster-whisper")
        component = pb.output_component()
        assert isinstance(component, str)
        assert len(component) > 0

    def test_workflow_dir(self, tmp_project):
        """workflow_dir returns correct directory structure."""
        pb = path_builder("faster-whisper", project_root=tmp_project)
        workflow_path = pb.workflow_dir()

        # Should be: transcripts / workflow_label / output_component
        assert "faster-whisper" in str(workflow_path)
        assert "transcripts" in str(workflow_path)

    def test_workflow_dir_with_custom_root(self, tmp_project):
        """workflow_dir respects custom root."""
        custom_root = tmp_project / "custom_transcripts"
        custom_root.mkdir()

        pb = path_builder("faster-whisper", project_root=tmp_project)
        workflow_path = pb.workflow_dir(root=custom_root)

        assert str(custom_root) in str(workflow_path)

    def test_artifact_path(self, tmp_project):
        """artifact_path returns expected file path."""
        pb = path_builder("faster-whisper", project_root=tmp_project)
        hash_component = "abc12345"
        path = pb.artifact_path(hash_component)

        assert hash_component in str(path)
        assert path.name == "transcript.json"

    def test_artifact_path_diarization(self, tmp_project):
        """artifact_path returns speakers.json for diarization."""
        pb = path_builder("pyannote", project_root=tmp_project)
        hash_component = "abc12345"
        path = pb.artifact_path(hash_component)

        assert path.name == "speakers.json"

    def test_artifact_exists_false_when_missing(self, tmp_project):
        """artifact_exists returns False when no artifact exists."""
        pb = path_builder("faster-whisper", project_root=tmp_project)
        assert pb.artifact_exists("nonexistent_hash") is False

    def test_artifact_exists_true_when_present(self, tmp_project):
        """artifact_exists returns True when artifact exists."""
        pb = path_builder("faster-whisper", project_root=tmp_project)
        hash_component = "abc12345"

        # Create the artifact
        artifact = pb.artifact_path(hash_component)
        artifact.parent.mkdir(parents=True)
        artifact.write_text('{"segments": []}')

        assert pb.artifact_exists(hash_component) is True

    def test_glob_matches(self, tmp_project):
        """glob_matches finds existing artifacts."""
        pb = path_builder("faster-whisper", project_root=tmp_project)
        hash_component = "def67890"

        # Create the artifact
        artifact = pb.artifact_path(hash_component)
        artifact.parent.mkdir(parents=True)
        artifact.write_text('{"segments": []}')

        matches = pb.glob_matches(hash_component)
        assert len(matches) == 1
        assert matches[0] == artifact


class TestConvenienceFunctions:
    """Tests for module-level convenience functions."""

    @pytest.fixture
    def tmp_project(self, tmp_path, monkeypatch):
        """Create a temporary project structure with isolated config."""
        (tmp_path / "transcripts").mkdir()
        from besedy.config.settings import config

        monkeypatch.setattr(config.paths, "text_data_dir", str(tmp_path))
        return tmp_path

    def test_transcripts_dir_function(self, tmp_project):
        """transcripts_dir convenience function works."""
        result = transcripts_dir("faster-whisper", project_root=tmp_project)
        assert isinstance(result, Path)
        assert "faster-whisper" in str(result)

    def test_artifact_path_function(self, tmp_project):
        """artifact_path convenience function works."""
        result = artifact_path("faster-whisper", "abc12345", project_root=tmp_project)
        assert isinstance(result, Path)
        assert "abc12345" in str(result)

    def test_artifact_exists_function(self, tmp_project):
        """artifact_exists convenience function works."""
        result = artifact_exists("faster-whisper", "nonexistent", project_root=tmp_project)
        assert result is False


class TestVramCalculation:
    """Tests for VRAM-based parallel instance calculation."""

    def test_get_available_vram_returns_none_on_failure(self):
        """get_available_vram_gb returns None when nvidia-smi fails."""
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = FileNotFoundError()
            result = get_available_vram_gb()
            assert result is None

    def test_get_available_vram_parses_output(self):
        """get_available_vram_gb correctly parses nvidia-smi output."""
        with patch("subprocess.run") as mock_run:
            mock_result = MagicMock()
            mock_result.stdout = "8192\n"  # 8GB in MB
            mock_run.return_value = mock_result

            result = get_available_vram_gb()
            assert result == 8.0  # 8192 MB / 1024 = 8 GB

    def test_calculate_parallel_instances_no_vram(self):
        """calculate_parallel_instances uses default when VRAM unavailable."""
        config = get_workflow_config("faster-whisper")

        with patch("besedy.lib.workflow.vram.get_available_vram_gb", return_value=None):
            result = calculate_parallel_instances(config)
            assert result == config.default_parallel

    def test_calculate_parallel_instances_with_vram(self):
        """calculate_parallel_instances calculates based on VRAM."""
        config = get_workflow_config("faster-whisper")
        # faster-whisper: 4GB per instance, 10% safety margin

        with patch("besedy.lib.workflow.vram.get_available_vram_gb", return_value=16.0):
            result = calculate_parallel_instances(config)
            # 16GB * 0.9 = 14.4GB usable, 14.4 / 4 = 3.6 -> 3 instances
            assert result == 3

    def test_calculate_parallel_instances_minimum_one(self):
        """calculate_parallel_instances returns at least 1."""
        config = get_workflow_config("canary-nemo")
        # canary-nemo: 9GB per instance

        with patch("besedy.lib.workflow.vram.get_available_vram_gb", return_value=4.0):
            result = calculate_parallel_instances(config)
            assert result >= 1

    def test_calculate_parallel_instances_aggressive_fill(self):
        """calculate_parallel_instances honors an aggressive_fill config."""
        # Synthetic config so the test stays pinned to the values it documents
        # rather than tracking any one production workflow's VRAM tuning.
        config = WorkflowConfig(
            workflow_id="aggressive-test",
            workflow_type="diarization",
            workflow_label="speaker_diarization",
            model_name="test-model",
            vram_per_instance_gb=3.0,
            safety_margin_gb=0.2,
            aggressive_fill=True,
        )

        with patch("besedy.lib.workflow.vram.get_available_vram_gb", return_value=10.0):
            result = calculate_parallel_instances(config)
            # (10 - 0.2) / 3 = 3.26 -> 3; aggressive fill cannot add a 4th
            # (4 * 3 + 0.2 = 12.2 > 10), so the count stays at 3.
            assert result == 3

    def test_calculate_parallel_instances_percent_margin(self):
        """calculate_parallel_instances handles percentage safety margin."""
        config = get_workflow_config("whisperx")
        # whisperx: 6GB per instance, 10% safety margin

        with patch("besedy.lib.workflow.vram.get_available_vram_gb", return_value=20.0):
            result = calculate_parallel_instances(config)
            # 20GB * 0.9 = 18GB usable, 18 / 6 = 3 instances
            assert result == 3
