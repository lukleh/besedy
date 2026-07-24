"""Tests for the run-pipeline command."""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

import pytest

from besedy.commands.catalog import pipeline
from besedy.commands.catalog.pipeline import (
    CORE_STEPS,
    DERIVED_STEPS,
    WorkflowConfig,
    derive_staging_dir_from_normalized_csv,
    handle_run_pipeline,
    print_step,
    rag_backend_key_for_workflow,
    resolve_pipeline_workflows,
    select_rag_workflows,
    should_run_rag_colbert_index,
)
from besedy.commands.catalog.pipeline_rag import default_pipeline_rag_backend_key
from besedy.commands.catalog.rag_colbert_index import RagColbertIndexRequest
from besedy.lib.rag_chunk_corpus import slugify_backend_key
from tests.helpers.workflows import make_workflow_config


class TestDeriveStagingDir:
    """Tests for staging directory derivation."""

    def test_derives_from_full_path(self, tmp_path):
        """Derives parent directory from Full Path column."""
        csv_path = tmp_path / "normalized.csv"
        csv_path.write_text("Hash,Full Path\nabc123,/staging/dir/file.wav\n")
        result = derive_staging_dir_from_normalized_csv(csv_path)
        assert result == Path("/staging/dir")

    def test_returns_none_for_missing_file(self, tmp_path):
        """Returns None when CSV file doesn't exist."""
        csv_path = tmp_path / "nonexistent.csv"
        result = derive_staging_dir_from_normalized_csv(csv_path)
        assert result is None

    def test_returns_none_for_empty_csv(self, tmp_path):
        """Returns None for CSV with header only."""
        csv_path = tmp_path / "empty.csv"
        csv_path.write_text("Hash,Full Path\n")
        result = derive_staging_dir_from_normalized_csv(csv_path)
        assert result is None

    def test_uses_first_row_with_full_path(self, tmp_path):
        """Uses the first row that has a Full Path value."""
        csv_path = tmp_path / "normalized.csv"
        csv_path.write_text(
            "Hash,Full Path\nhash1,/staging/first/file1.wav\nhash2,/staging/second/file2.wav\n"
        )
        result = derive_staging_dir_from_normalized_csv(csv_path)
        assert result == Path("/staging/first")

    def test_handles_empty_full_path(self, tmp_path):
        """Skips rows with empty Full Path."""
        csv_path = tmp_path / "normalized.csv"
        csv_path.write_text("Hash,Full Path\nhash1,\nhash2,/staging/dir/file.wav\n")
        result = derive_staging_dir_from_normalized_csv(csv_path)
        assert result == Path("/staging/dir")

    def test_logs_debug_when_csv_cannot_be_read(self, tmp_path, caplog):
        """Logs a debug message and returns None for malformed CSV input."""
        csv_path = tmp_path / "normalized.csv"
        csv_path.write_bytes(b"Hash,Full Path\nabc,\xff\n")

        with caplog.at_level(logging.DEBUG, logger=pipeline.__name__):
            result = derive_staging_dir_from_normalized_csv(csv_path)

        assert result is None
        assert f"failed to derive staging dir from {csv_path}" in caplog.text


class TestPrintStep:
    """Tests for step header printing."""

    def test_print_step_basic(self, capsys):
        """Basic step printing without detail."""
        print_step(1, 5, "test-step")
        captured = capsys.readouterr()
        assert "[1/5] test-step" in captured.out
        assert "=" * 60 in captured.out

    def test_print_step_with_detail(self, capsys):
        """Step printing with detail in parentheses."""
        print_step(2, 10, "transcribe", "faster-whisper")
        captured = capsys.readouterr()
        assert "[2/10] transcribe (faster-whisper)" in captured.out


class TestStepDefinitions:
    """Tests for pipeline step constants."""

    def test_core_steps_count(self):
        """CORE_STEPS has expected number of steps."""
        assert len(CORE_STEPS) == 5

    def test_core_steps_names(self):
        """CORE_STEPS contains expected step names."""
        step_names = [s[0] for s in CORE_STEPS]
        assert "loudness" in step_names
        assert "stage-audio" in step_names
        assert "transcribe" in step_names
        assert "diarize" in step_names

    def test_derived_steps_count(self):
        """DERIVED_STEPS has expected number of steps."""
        assert len(DERIVED_STEPS) == 2

    def test_derived_steps_names(self):
        """DERIVED_STEPS contains expected step names."""
        step_names = [s[0] for s in DERIVED_STEPS]
        assert "export-transcripts" in step_names
        assert "cluster-speakers" in step_names

    def test_steps_have_descriptions(self):
        """All steps have non-empty descriptions."""
        for name, description in CORE_STEPS + DERIVED_STEPS:
            assert name, "Step name should not be empty"
            assert description, f"Step {name} should have a description"


class TestWorkflowConfiguration:
    """Tests for workflows derived from config."""

    def test_transcribe_workflow_ids_not_empty(self):
        """The pipeline should have at least one transcription workflow."""
        transcription_workflows, _ = resolve_pipeline_workflows()
        assert len(transcription_workflows) > 0

    def test_diarize_workflow_ids_not_empty(self):
        """The pipeline should have at least one diarization workflow."""
        _, diarization_workflow_ids = resolve_pipeline_workflows()
        assert len(diarization_workflow_ids) > 0

    def test_transcribe_workflow_ids_are_strings(self):
        """All transcription workflow IDs are strings."""
        transcription_workflows, _ = resolve_pipeline_workflows()
        for wf in transcription_workflows:
            assert isinstance(wf.workflow_id, str)
            assert len(wf.workflow_id) > 0

    def test_diarize_workflow_ids_are_strings(self):
        """All diarization workflow IDs are strings."""
        _, diarization_workflow_ids = resolve_pipeline_workflows()
        for wf_id in diarization_workflow_ids:
            assert isinstance(wf_id, str)
            assert len(wf_id) > 0

    def test_transcribe_contains_expected_workflows(self):
        """The default pipeline contains only production transcription workflows."""
        expected = {"faster-whisper", "canary-nemo", "whisperx"}
        transcription_workflows, _ = resolve_pipeline_workflows()
        actual = {wf.workflow_id for wf in transcription_workflows}
        assert expected == actual, f"Expected {expected}, got {actual}"

    def test_diarize_contains_expected_workflows(self):
        """The pipeline contains known diarization workflows."""
        expected = {"pyannote"}
        _, diarization_workflow_ids = resolve_pipeline_workflows()
        actual = set(diarization_workflow_ids)
        assert expected == actual, f"Expected {expected}, got {actual}"


class TestStepNumberingCalculation:
    """Tests for dynamic step counting logic."""

    def test_total_steps_with_derived(self):
        """Total steps includes all workflows and derived steps."""
        transcription_workflows, diarization_workflow_ids = resolve_pipeline_workflows()
        total = (
            3
            + len(transcription_workflows)
            + len(diarization_workflow_ids)
            + len(DERIVED_STEPS)
        )
        assert total == (
            3 + len(transcription_workflows) + len(diarization_workflow_ids) + 2
        )

    def test_total_steps_without_derived(self):
        """Total steps without derived is fewer."""
        transcription_workflows, diarization_workflow_ids = resolve_pipeline_workflows()
        total = 3 + len(transcription_workflows) + len(diarization_workflow_ids)
        total_with_derived = total + len(DERIVED_STEPS)
        assert total_with_derived - total == len(DERIVED_STEPS)


def _pipeline_args(**overrides) -> argparse.Namespace:
    args = {
        "csv": None,
        "continue_on_error": False,
        "skip_derived": True,
        "no_symlink": True,
        "skip_rag_colbert_index": False,
        "rag_backend": None,
        "rag_all_backends": False,
        "rag_force": False,
        "rag_colbert_index_dir": None,
        "rag_colbert_model": "jinaai/jina-colbert-v2",
        "rag_chunk_tokenizer_model": None,
        "rag_colbert_doc_maxlen": 384,
        "rag_colbert_index_bsize": 32,
        "rag_colbert_use_faiss": False,
        "rag_colbert_runtime": None,
        "rag_min_chunk_tokens": 180,
        "rag_max_chunk_tokens": 260,
        "rag_overlap_tokens": 40,
    }
    args.update(overrides)
    return argparse.Namespace(**args)


@pytest.mark.parametrize(
    ("skip_derived", "cluster_result", "expected_cluster_calls", "expected_exit_code"),
    [(False, 0, 1, 0), (True, 0, 0, 0), (False, 1, 1, 1)],
)
def test_run_pipeline_owns_speaker_clustering(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    skip_derived: bool,
    cluster_result: int,
    expected_cluster_calls: int,
    expected_exit_code: int,
) -> None:
    timestamp = "20260102_030405"
    csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
    csv_path.write_text("Hash,Full Path\n", encoding="utf-8")

    diarize_calls = []
    cluster_calls = []

    monkeypatch.setattr(
        pipeline,
        "resolve_pipeline_workflows",
        lambda: ([], ["pyannote"]),
    )
    monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
    monkeypatch.setattr(pipeline, "resolve_catalogs_root", lambda: tmp_path)
    monkeypatch.setattr(pipeline, "resolve_transcripts_parent", lambda: tmp_path)
    monkeypatch.setattr(pipeline, "handle_loudness", lambda _args: 0)
    monkeypatch.setattr(pipeline, "handle_stage_audio", lambda _args: 0)
    monkeypatch.setattr(pipeline, "handle_archive", lambda _args: 0)
    monkeypatch.setattr(
        pipeline, "handle_diarize", lambda request: diarize_calls.append(request) or 0
    )
    monkeypatch.setattr(pipeline, "handle_export_transcripts", lambda _request: 0)
    monkeypatch.setattr(
        pipeline,
        "handle_cluster_speakers",
        lambda request: cluster_calls.append(request) or cluster_result,
    )
    monkeypatch.setattr(pipeline, "print_step", lambda *_args, **_kwargs: None)

    result = handle_run_pipeline(
        _pipeline_args(skip_derived=skip_derived, skip_rag_colbert_index=True)
    )
    assert result == expected_exit_code
    assert len(diarize_calls) == 1
    assert not hasattr(diarize_calls[0], "skip_cluster")
    assert len(cluster_calls) == expected_cluster_calls


class TestPipelineRagIndexing:
    """Tests for RAG indexing integration in run-pipeline."""

    def test_select_rag_workflows_defaults_to_active_backend(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        faster_workflow = WorkflowConfig(
            workflow_id="faster-whisper",
            workflow_type="transcription",
            workflow_label="faster-whisper",
            model_name="large-v3",
            vad_model="silero_vad_v6",
        )
        canary_workflow = WorkflowConfig(
            workflow_id="canary-nemo",
            workflow_type="transcription",
            workflow_label="canary-nemo",
            model_name="nvidia/canary-1b-v2",
            vad_model="nvidia/Frame_VAD_Multilingual_MarbleNet_v2.0",
            decode_strategy="greedy",
        )

        faster_key = rag_backend_key_for_workflow(faster_workflow)
        monkeypatch.setattr(
            "besedy.commands.catalog.pipeline._resolve_pipeline_rag_backend_key",
            lambda _args: faster_key,
        )

        selected, target_backend = select_rag_workflows(
            _pipeline_args(),
            [canary_workflow, faster_workflow],
        )

        assert target_backend == faster_key
        assert selected == [faster_workflow]

    def test_select_rag_workflows_can_enable_all_backends(self) -> None:
        faster_workflow = WorkflowConfig(
            workflow_id="faster-whisper",
            workflow_type="transcription",
            workflow_label="faster-whisper",
            model_name="large-v3",
            vad_model="silero_vad_v6",
        )
        canary_workflow = WorkflowConfig(
            workflow_id="canary-nemo",
            workflow_type="transcription",
            workflow_label="canary-nemo",
            model_name="nvidia/canary-1b-v2",
            vad_model="nvidia/Frame_VAD_Multilingual_MarbleNet_v2.0",
            decode_strategy="greedy",
        )

        selected, target_backend = select_rag_workflows(
            _pipeline_args(rag_all_backends=True),
            [canary_workflow, faster_workflow],
        )

        assert target_backend is None
        assert selected == [canary_workflow, faster_workflow]

    def test_select_rag_workflows_requires_exact_backend_key(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        workflow = WorkflowConfig(
            workflow_id="faster-whisper",
            workflow_type="transcription",
            workflow_label="faster-whisper",
            model_name="large-v3",
            vad_model="silero_vad_v6",
            language="auto",
        )
        legacy_key = "faster-whisper/large-v3@silero_vad_v6"
        monkeypatch.setattr(
            "besedy.commands.catalog.pipeline._resolve_pipeline_rag_backend_key",
            lambda _args: legacy_key,
        )

        selected, target_backend = select_rag_workflows(_pipeline_args(), [workflow])

        assert selected == []
        assert target_backend == legacy_key

    def test_run_pipeline_rejects_nonmatching_rag_backend(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        timestamp = "20260102_030405"
        csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
        csv_path.write_text("Hash,Full Path\n", encoding="utf-8")
        workflow = make_workflow_config(language="auto")

        monkeypatch.setattr(
            pipeline,
            "resolve_pipeline_workflows",
            lambda: ([workflow], []),
        )
        monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
        monkeypatch.setattr(pipeline, "should_run_rag_colbert_index", lambda _args: True)
        monkeypatch.setattr(
            pipeline,
            "_resolve_pipeline_rag_backend_key",
            lambda _args: "faster-whisper/large-v3@silero_vad_v6",
        )

        assert handle_run_pipeline(_pipeline_args()) == 1
        stderr = capsys.readouterr().err
        assert "does not exactly match" in stderr
        assert "RAG_BACKEND_KEY" in stderr
        assert "--skip-rag-colbert-index" in stderr
        assert "rebuild the index" in stderr

    def test_run_pipeline_reports_unresolvable_rag_backend_key(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """No faster-whisper workflow means a clean error, not a traceback."""
        timestamp = "20260102_030405"
        csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
        csv_path.write_text("Hash,Full Path\n", encoding="utf-8")
        canary = make_workflow_config(workflow_id="canary-nemo", workflow_label="canary-nemo")

        def raise_runtime_error(_args):
            raise RuntimeError("No faster-whisper workflow configured in besedy.toml.")

        monkeypatch.setattr(
            pipeline,
            "resolve_pipeline_workflows",
            lambda: ([canary], []),
        )
        monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
        monkeypatch.setattr(pipeline, "should_run_rag_colbert_index", lambda _args: True)
        monkeypatch.setattr(pipeline, "_resolve_pipeline_rag_backend_key", raise_runtime_error)

        assert handle_run_pipeline(_pipeline_args()) == 1
        stderr = capsys.readouterr().err
        assert "cannot resolve the RAG backend key" in stderr
        assert "--skip-rag-colbert-index" in stderr

    def test_default_rag_backend_key_requires_a_faster_whisper_workflow(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            "besedy.commands.catalog.rag_backend.get_transcription_workflows",
            lambda **_kwargs: [],
        )

        with pytest.raises(RuntimeError, match="No faster-whisper workflow configured"):
            default_pipeline_rag_backend_key()

    def test_run_pipeline_all_backends_skips_indexing_when_no_workflows_enabled(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """--rag-all-backends with zero pipeline workflows skips indexing, not the run."""
        timestamp = "20260102_030405"
        csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
        csv_path.write_text("Hash,Full Path\n", encoding="utf-8")

        monkeypatch.setattr(pipeline, "resolve_pipeline_workflows", lambda: ([], []))
        monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
        monkeypatch.setattr(pipeline, "resolve_catalogs_root", lambda: tmp_path)
        monkeypatch.setattr(pipeline, "resolve_transcripts_parent", lambda: tmp_path)
        monkeypatch.setattr(pipeline, "handle_loudness", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_stage_audio", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_archive", lambda _args: 0)
        monkeypatch.setattr(pipeline, "should_run_rag_colbert_index", lambda _args: True)

        assert handle_run_pipeline(_pipeline_args(rag_all_backends=True)) == 0
        stderr = capsys.readouterr().err
        assert "skipping rag-colbert-index because no transcription workflows" in stderr

    def test_default_rag_backend_key_derives_from_configured_workflow(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The default key follows besedy.toml instead of a hardcoded literal."""
        workflow = make_workflow_config(language="cs")
        monkeypatch.setattr(
            "besedy.commands.catalog.rag_backend.get_transcription_workflows",
            lambda **_kwargs: [workflow],
        )

        assert default_pipeline_rag_backend_key() == "faster-whisper/large-v3@silero_vad_v6"

    def test_should_run_rag_colbert_index_enabled_by_default(self) -> None:
        with pytest.MonkeyPatch.context() as monkeypatch:
            seen_runtimes: list[str | None] = []

            monkeypatch.setattr(pipeline, "default_colbert_index_runtime", lambda: "docker-indexer")
            monkeypatch.setattr(
                pipeline,
                "check_colbert_runtime_ready",
                lambda runtime_override=None: seen_runtimes.append(runtime_override),
            )
            assert should_run_rag_colbert_index(_pipeline_args()) is True
            assert seen_runtimes == ["docker-indexer"]

    def test_should_run_rag_colbert_index_defaults_to_docker_on_cpu_only_host(self) -> None:
        with pytest.MonkeyPatch.context() as monkeypatch:
            seen_runtimes: list[str | None] = []

            monkeypatch.setattr(pipeline, "default_colbert_index_runtime", lambda: "docker")
            monkeypatch.setattr(
                pipeline,
                "check_colbert_runtime_ready",
                lambda runtime_override=None: seen_runtimes.append(runtime_override),
            )
            assert should_run_rag_colbert_index(_pipeline_args()) is True
            assert seen_runtimes == ["docker"]

    def test_should_run_rag_colbert_index_honors_runtime_env_override(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker-indexer")
        seen_runtimes: list[str | None] = []

        monkeypatch.setattr(
            pipeline,
            "check_colbert_runtime_ready",
            lambda runtime_override=None: seen_runtimes.append(runtime_override),
        )

        assert should_run_rag_colbert_index(_pipeline_args()) is True
        assert seen_runtimes == ["docker-indexer"]

    def test_should_run_rag_colbert_index_skips_when_runtime_is_unavailable(
        self,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setattr(
            pipeline,
            "check_colbert_runtime_ready",
            lambda runtime_override=None: (_ for _ in ()).throw(
                RuntimeError("ColBERT Docker service is not running.")
            ),
        )

        assert should_run_rag_colbert_index(_pipeline_args()) is False
        captured = capsys.readouterr()
        assert "skipping rag-colbert-index" in captured.err

    def test_should_run_rag_colbert_index_honors_skip_flag(self) -> None:
        assert should_run_rag_colbert_index(_pipeline_args(skip_rag_colbert_index=True)) is False

    def test_resolve_pipeline_rag_backend_key_can_auto_discover_backend_without_db(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        env_file = tmp_path / "web.env.prod"
        env_file.write_text(
            "RAG_BACKEND_KEY=canary-nemo/nvidia_canary-1b-v2_beam\n", encoding="utf-8"
        )

        monkeypatch.setenv("BESEDY_WEB_ENV_PROD", str(env_file))
        monkeypatch.delenv("RAG_BACKEND_KEY", raising=False)
        assert (
            pipeline._resolve_pipeline_rag_backend_key(_pipeline_args())
            == "canary-nemo/nvidia_canary-1b-v2_beam"
        )

    def test_run_pipeline_triggers_colbert_index_for_selected_backend(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        timestamp = "20260102_030405"
        csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
        csv_path.write_text("Hash,Full Path\n", encoding="utf-8")

        catalogs_root = tmp_path / "catalogs"
        catalogs_root.mkdir()
        transcripts_parent = tmp_path / "transcripts"
        transcripts_parent.mkdir()

        faster_workflow = WorkflowConfig(
            workflow_id="faster-whisper",
            workflow_type="transcription",
            workflow_label="faster-whisper",
            model_name="large-v3",
            vad_model="silero_vad_v6",
        )
        canary_workflow = WorkflowConfig(
            workflow_id="canary-nemo",
            workflow_type="transcription",
            workflow_label="canary-nemo",
            model_name="nvidia/canary-1b-v2",
            vad_model="nvidia/Frame_VAD_Multilingual_MarbleNet_v2.0",
            decode_strategy="greedy",
        )

        colbert_calls: list[RagColbertIndexRequest] = []
        transcribe_calls = []

        monkeypatch.setattr(
            pipeline,
            "resolve_pipeline_workflows",
            lambda: ([canary_workflow, faster_workflow], []),
        )
        monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
        monkeypatch.setattr(pipeline, "resolve_catalogs_root", lambda: catalogs_root)
        monkeypatch.setattr(pipeline, "resolve_transcripts_parent", lambda: transcripts_parent)
        monkeypatch.setattr(pipeline, "default_colbert_index_runtime", lambda: "docker-indexer")
        monkeypatch.setattr(pipeline, "check_colbert_runtime_ready", lambda _runtime=None: None)
        monkeypatch.setattr(pipeline, "backend_has_transcripts", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(pipeline, "handle_loudness", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_stage_audio", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_archive", lambda _args: 0)
        monkeypatch.setattr(
            pipeline,
            "handle_transcribe",
            lambda request: transcribe_calls.append(request) or 0,
        )
        monkeypatch.setattr(pipeline, "print_step", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(
            pipeline,
            "handle_rag_colbert_index",
            lambda args: colbert_calls.append(args) or 0,
        )
        monkeypatch.setattr(
            pipeline,
            "_resolve_pipeline_rag_backend_key",
            lambda _args: default_pipeline_rag_backend_key(),
        )

        args = _pipeline_args(
            rag_min_chunk_tokens=150,
            rag_max_chunk_tokens=250,
            rag_overlap_tokens=40,
            rag_force=True,
            rag_colbert_index_dir=Path("tmp/rag-colbert-debug"),
            rag_colbert_model="acme/colbert-demo",
            rag_chunk_tokenizer_model="acme/chunk-tokenizer",
            rag_colbert_doc_maxlen=512,
            rag_colbert_index_bsize=16,
            rag_colbert_use_faiss=True,
        )

        assert handle_run_pipeline(args) == 0
        assert [request.language for request in transcribe_calls] == [
            canary_workflow.language,
            faster_workflow.language,
        ]
        assert len(colbert_calls) == 1

        colbert_args = colbert_calls[0]
        assert colbert_args.group == timestamp
        assert colbert_args.backend == rag_backend_key_for_workflow(faster_workflow)
        assert colbert_args.transcripts_root == transcripts_parent / f"transcripts_{timestamp}"
        assert colbert_args.index_dir == Path("tmp/rag-colbert-debug")
        assert colbert_args.model == "acme/colbert-demo"
        assert colbert_args.chunk_tokenizer_model == "acme/chunk-tokenizer"
        assert colbert_args.doc_maxlen == 512
        assert colbert_args.index_bsize == 16
        assert colbert_args.use_faiss is True
        assert colbert_args.min_chunk_tokens == 150
        assert colbert_args.max_chunk_tokens == 250
        assert colbert_args.overlap_tokens == 40
        assert colbert_args.force is True
        assert colbert_args.runtime == "docker-indexer"

    def test_run_pipeline_can_colbert_index_all_backends_when_requested(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        timestamp = "20260102_030405"
        csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
        csv_path.write_text("Hash,Full Path\n", encoding="utf-8")

        faster_workflow = WorkflowConfig(
            workflow_id="faster-whisper",
            workflow_type="transcription",
            workflow_label="faster-whisper",
            model_name="large-v3",
            vad_model="silero_vad_v6",
        )
        canary_workflow = WorkflowConfig(
            workflow_id="canary-nemo",
            workflow_type="transcription",
            workflow_label="canary-nemo",
            model_name="nvidia/canary-1b-v2",
            vad_model="nvidia/Frame_VAD_Multilingual_MarbleNet_v2.0",
            decode_strategy="greedy",
        )

        colbert_calls: list[RagColbertIndexRequest] = []

        monkeypatch.setattr(
            pipeline,
            "resolve_pipeline_workflows",
            lambda: ([canary_workflow, faster_workflow], []),
        )
        monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
        monkeypatch.setattr(pipeline, "resolve_catalogs_root", lambda: tmp_path)
        monkeypatch.setattr(
            pipeline, "resolve_transcripts_parent", lambda: tmp_path / "transcripts"
        )
        monkeypatch.setattr(pipeline, "check_colbert_runtime_ready", lambda _runtime=None: None)
        monkeypatch.setattr(pipeline, "backend_has_transcripts", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(pipeline, "handle_loudness", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_stage_audio", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_archive", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_transcribe", lambda _args: 0)
        monkeypatch.setattr(pipeline, "print_step", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(
            pipeline,
            "handle_rag_colbert_index",
            lambda args: colbert_calls.append(args) or 0,
        )

        assert handle_run_pipeline(_pipeline_args(rag_all_backends=True)) == 0
        assert {call.backend for call in colbert_calls} == {
            rag_backend_key_for_workflow(canary_workflow),
            rag_backend_key_for_workflow(faster_workflow),
        }

    def test_run_pipeline_scopes_explicit_colbert_index_dir_for_all_backends(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        timestamp = "20260102_030405"
        csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
        csv_path.write_text("Hash,Full Path\n", encoding="utf-8")

        faster_workflow = WorkflowConfig(
            workflow_id="faster-whisper",
            workflow_type="transcription",
            workflow_label="faster-whisper",
            model_name="large-v3",
            vad_model="silero_vad_v6",
        )
        canary_workflow = WorkflowConfig(
            workflow_id="canary-nemo",
            workflow_type="transcription",
            workflow_label="canary-nemo",
            model_name="nvidia/canary-1b-v2",
            vad_model="nvidia/Frame_VAD_Multilingual_MarbleNet_v2.0",
            decode_strategy="greedy",
        )

        colbert_calls: list[RagColbertIndexRequest] = []

        monkeypatch.setattr(
            pipeline,
            "resolve_pipeline_workflows",
            lambda: ([canary_workflow, faster_workflow], []),
        )
        monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
        monkeypatch.setattr(pipeline, "resolve_catalogs_root", lambda: tmp_path)
        monkeypatch.setattr(
            pipeline, "resolve_transcripts_parent", lambda: tmp_path / "transcripts"
        )
        monkeypatch.setattr(pipeline, "check_colbert_runtime_ready", lambda _runtime=None: None)
        monkeypatch.setattr(pipeline, "backend_has_transcripts", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(pipeline, "handle_loudness", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_stage_audio", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_archive", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_transcribe", lambda _args: 0)
        monkeypatch.setattr(pipeline, "print_step", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(
            pipeline,
            "handle_rag_colbert_index",
            lambda args: colbert_calls.append(args) or 0,
        )

        assert (
            handle_run_pipeline(
                _pipeline_args(
                    rag_all_backends=True,
                    rag_colbert_index_dir=Path("tmp/rag-colbert-debug"),
                )
            )
            == 0
        )

        assert {call.index_dir for call in colbert_calls} == {
            Path("tmp/rag-colbert-debug")
            / slugify_backend_key(rag_backend_key_for_workflow(canary_workflow)),
            Path("tmp/rag-colbert-debug")
            / slugify_backend_key(rag_backend_key_for_workflow(faster_workflow)),
        }

    def test_run_pipeline_colbert_index_defaults_to_docker_indexer_without_database_config(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        timestamp = "20260102_030405"
        csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
        csv_path.write_text("Hash,Full Path\n", encoding="utf-8")

        workflow = WorkflowConfig(
            workflow_id="faster-whisper",
            workflow_type="transcription",
            workflow_label="faster-whisper",
            model_name="large-v3",
            vad_model="silero_vad_v6",
        )

        colbert_calls: list[RagColbertIndexRequest] = []

        monkeypatch.setattr(
            pipeline,
            "resolve_pipeline_workflows",
            lambda: ([workflow], []),
        )
        monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
        monkeypatch.setattr(pipeline, "resolve_catalogs_root", lambda: tmp_path)
        monkeypatch.setattr(
            pipeline, "resolve_transcripts_parent", lambda: tmp_path / "transcripts"
        )
        monkeypatch.setattr(pipeline, "default_colbert_index_runtime", lambda: "docker-indexer")
        monkeypatch.setattr(pipeline, "check_colbert_runtime_ready", lambda _runtime=None: None)
        monkeypatch.setattr(pipeline, "backend_has_transcripts", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(pipeline, "handle_loudness", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_stage_audio", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_archive", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_transcribe", lambda _args: 0)
        monkeypatch.setattr(pipeline, "print_step", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(
            pipeline,
            "handle_rag_colbert_index",
            lambda args: colbert_calls.append(args) or 0,
        )
        monkeypatch.setattr(
            pipeline,
            "_resolve_pipeline_rag_backend_key",
            lambda _args: default_pipeline_rag_backend_key(),
        )

        assert handle_run_pipeline(_pipeline_args()) == 0
        assert len(colbert_calls) == 1
        assert colbert_calls[0].runtime == "docker-indexer"

    def test_run_pipeline_forwards_explicit_colbert_runtime_override(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        timestamp = "20260102_030405"
        csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
        csv_path.write_text("Hash,Full Path\n", encoding="utf-8")

        workflow = WorkflowConfig(
            workflow_id="faster-whisper",
            workflow_type="transcription",
            workflow_label="faster-whisper",
            model_name="large-v3",
            vad_model="silero_vad_v6",
        )

        colbert_calls: list[RagColbertIndexRequest] = []

        monkeypatch.setattr(
            pipeline,
            "resolve_pipeline_workflows",
            lambda: ([workflow], []),
        )
        monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
        monkeypatch.setattr(pipeline, "resolve_catalogs_root", lambda: tmp_path)
        monkeypatch.setattr(
            pipeline, "resolve_transcripts_parent", lambda: tmp_path / "transcripts"
        )
        monkeypatch.setattr(pipeline, "check_colbert_runtime_ready", lambda _runtime=None: None)
        monkeypatch.setattr(pipeline, "backend_has_transcripts", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(pipeline, "handle_loudness", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_stage_audio", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_archive", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_transcribe", lambda _args: 0)
        monkeypatch.setattr(pipeline, "print_step", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(
            pipeline,
            "handle_rag_colbert_index",
            lambda args: colbert_calls.append(args) or 0,
        )
        monkeypatch.setattr(
            pipeline,
            "_resolve_pipeline_rag_backend_key",
            lambda _args: default_pipeline_rag_backend_key(),
        )

        assert handle_run_pipeline(_pipeline_args()) == 0
        assert len(colbert_calls) == 1
        assert colbert_calls[0].runtime == "docker-indexer"

    def test_run_pipeline_skips_colbert_index_when_disabled(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        timestamp = "20260102_030405"
        csv_path = tmp_path / f"audio_catalog_{timestamp}.csv"
        csv_path.write_text("Hash,Full Path\n", encoding="utf-8")

        workflow = WorkflowConfig(
            workflow_id="faster-whisper",
            workflow_type="transcription",
            workflow_label="faster-whisper",
            model_name="large-v3",
            vad_model="silero_vad_v6",
        )

        colbert_calls: list[RagColbertIndexRequest] = []

        monkeypatch.setattr(
            pipeline,
            "resolve_pipeline_workflows",
            lambda: ([workflow], []),
        )
        monkeypatch.setattr(pipeline, "resolve_catalog_csv", lambda *_args, **_kwargs: csv_path)
        monkeypatch.setattr(pipeline, "resolve_catalogs_root", lambda: tmp_path)
        monkeypatch.setattr(
            pipeline, "resolve_transcripts_parent", lambda: tmp_path / "transcripts"
        )
        monkeypatch.setattr(
            pipeline,
            "check_colbert_runtime_ready",
            lambda runtime_override=None: (_ for _ in ()).throw(
                RuntimeError("ColBERT Docker service is not running.")
            ),
        )
        monkeypatch.setattr(pipeline, "handle_loudness", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_stage_audio", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_archive", lambda _args: 0)
        monkeypatch.setattr(pipeline, "handle_transcribe", lambda _args: 0)
        monkeypatch.setattr(pipeline, "print_step", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(
            pipeline,
            "handle_rag_colbert_index",
            lambda args: colbert_calls.append(args) or 0,
        )

        assert handle_run_pipeline(_pipeline_args(skip_rag_colbert_index=True)) == 0
        assert colbert_calls == []
