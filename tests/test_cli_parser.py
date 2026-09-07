"""Tests for CLI argument parsing.

Tests pure Python argument parsing without requiring external tools.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest

from besedy.cli.catalog import build_parser, main


class TestCatalogParserStructure:
    """Tests for catalog CLI parser structure."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_parser_has_subcommands(self, parser):
        """Parser has subparsers for commands."""
        # Parser should have subparsers
        assert parser._subparsers is not None

    def test_subcommand_names(self, parser):
        """All expected subcommands are registered."""
        # Get subparser actions
        subparsers_action = None
        for action in parser._actions:
            if isinstance(action, argparse._SubParsersAction):
                subparsers_action = action
                break

        assert subparsers_action is not None
        expected = {
            "create",
            "merge",
            "add",
            "check",
            "check-durations",
            "clean",
            "loudness",
            "validate",
            "stage-audio",
            "transcribe",
            "diarize",
            "export-transcripts",
            "cluster-speakers",
            "find-duplicates",
            "archive",
            "run-pipeline",
            "join",
            "hash",
            "rag-colbert-index",
        }
        assert set(subparsers_action.choices.keys()) == expected


class TestCreateCommand:
    """Tests for 'create' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_create_requires_directory(self, parser):
        """Create command requires a directory argument."""
        with pytest.raises(SystemExit):
            parser.parse_args(["create"])

    def test_create_with_directory(self, parser):
        """Create command accepts directory path."""
        args = parser.parse_args(["create", "/path/to/media"])
        assert args.command == "create"
        assert args.directory == Path("/path/to/media")

    def test_create_with_output(self, parser):
        """Create command accepts --output option."""
        args = parser.parse_args(["create", "/media", "--output", "out.csv"])
        assert args.output == Path("out.csv")

    def test_create_ffprobe_binary(self, parser):
        """Create command accepts --ffprobe-binary option."""
        args = parser.parse_args(["create", "/media", "--ffprobe-binary", "/usr/bin/ffprobe"])
        assert args.ffprobe_binary == "/usr/bin/ffprobe"

    def test_create_ffprobe_timeout(self, parser):
        """Create command accepts --ffprobe-timeout option."""
        args = parser.parse_args(["create", "/media", "--ffprobe-timeout", "30"])
        assert args.ffprobe_timeout == 30

    def test_create_no_color_flag(self, parser):
        """Create command accepts --no-color flag."""
        args = parser.parse_args(["create", "/media", "--no-color"])
        assert args.no_color is True


class TestMergeCommand:
    """Tests for 'merge' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_merge_requires_two_sources(self, parser):
        """Merge command requires two source arguments."""
        with pytest.raises(SystemExit):
            parser.parse_args(["merge"])
        with pytest.raises(SystemExit):
            parser.parse_args(["merge", "source1.csv"])

    def test_merge_with_sources(self, parser):
        """Merge command accepts two source paths."""
        args = parser.parse_args(["merge", "a.csv", "b.csv"])
        assert args.command == "merge"
        assert args.source1 == Path("a.csv")
        assert args.source2 == Path("b.csv")

    def test_merge_with_output(self, parser):
        """Merge command accepts --output option."""
        args = parser.parse_args(["merge", "a.csv", "b.csv", "--output", "merged.csv"])
        assert args.output == Path("merged.csv")

    def test_merge_encoding(self, parser):
        """Merge command accepts --encoding option."""
        args = parser.parse_args(["merge", "a.csv", "b.csv", "--encoding", "latin-1"])
        assert args.encoding == "latin-1"

    def test_merge_default_encoding_utf8(self, parser):
        """--encoding defaults to utf-8."""
        args = parser.parse_args(["merge", "a.csv", "b.csv"])
        assert args.encoding == "utf-8"


class TestStageAudioCommand:
    """Tests for 'stage-audio' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_stage_audio_no_required_args(self, parser):
        """Stage-audio works with defaults."""
        args = parser.parse_args(["stage-audio"])
        assert args.command == "stage-audio"
        assert args.csv is None
        assert args.output_dir is None

    def test_stage_audio_with_csv(self, parser):
        """Stage-audio accepts --csv option."""
        args = parser.parse_args(["stage-audio", "--csv", "catalog.csv"])
        assert args.csv == Path("catalog.csv")

    def test_stage_audio_with_output_dir(self, parser):
        """Stage-audio accepts --output-dir option."""
        args = parser.parse_args(["stage-audio", "--output-dir", "/tmp/staging"])
        assert args.output_dir == Path("/tmp/staging")

    def test_stage_audio_skip_analysis_flag(self, parser):
        """Stage-audio accepts --skip-audio-analysis flag."""
        args = parser.parse_args(["stage-audio", "--skip-audio-analysis"])
        assert args.skip_audio_analysis is True

    def test_stage_audio_no_aggressive_normalization(self, parser):
        """Stage-audio accepts --no-aggressive-normalization flag."""
        args = parser.parse_args(["stage-audio", "--no-aggressive-normalization"])
        assert args.no_aggressive_normalization is True

    def test_stage_audio_continue_on_error(self, parser):
        """Stage-audio accepts --continue-on-error flag."""
        args = parser.parse_args(["stage-audio", "--continue-on-error"])
        assert args.continue_on_error is True

    def test_stage_audio_limit(self, parser):
        """Stage-audio accepts --limit option."""
        args = parser.parse_args(["stage-audio", "--limit", "10"])
        assert args.limit == 10


class TestTranscribeCommand:
    """Tests for 'transcribe' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_transcribe_defaults(self, parser):
        """Transcribe works with defaults."""
        args = parser.parse_args(["transcribe"])
        assert args.command == "transcribe"
        assert args.csv is None
        assert args.overwrite is False
        assert args.continue_on_error is False

    def test_transcribe_with_csv(self, parser):
        """Transcribe accepts --csv option."""
        args = parser.parse_args(["transcribe", "--csv", "normalized.csv"])
        assert args.csv == Path("normalized.csv")

    def test_transcribe_overwrite_flag(self, parser):
        """Transcribe accepts --overwrite flag."""
        args = parser.parse_args(["transcribe", "--overwrite"])
        assert args.overwrite is True

    def test_transcribe_workflow_choices(self, parser):
        """Transcribe --workflow accepts valid choices."""
        args = parser.parse_args(["transcribe", "--workflow", "canary-nemo"])
        assert args.workflows == ["canary-nemo"]

        args = parser.parse_args(["transcribe", "--workflow", "whisperx"])
        assert args.workflows == ["whisperx"]

        args = parser.parse_args(["transcribe", "--workflow", "faster-whisper"])
        assert args.workflows == ["faster-whisper"]

    def test_transcribe_multiple_workflows(self, parser):
        """Transcribe accepts multiple --workflow options."""
        args = parser.parse_args(
            [
                "transcribe",
                "--workflow",
                "canary-nemo",
                "--workflow",
                "faster-whisper",
            ]
        )
        assert args.workflows == ["canary-nemo", "faster-whisper"]

    def test_transcribe_model_override(self, parser):
        """Transcribe accepts --model override."""
        args = parser.parse_args(["transcribe", "--workflow", "whisperx", "--model", "large-v3"])
        assert args.model == "large-v3"

    def test_transcribe_language_selector(self, parser):
        """Transcribe accepts a configured language selector."""
        args = parser.parse_args(
            ["transcribe", "--workflow", "faster-whisper", "--language", "auto"]
        )
        assert args.language == "auto"

    def test_transcribe_workflow_labels_are_validated_at_execution(self, parser):
        """Configured workflow labels remain parseable without loading config."""
        args = parser.parse_args(["transcribe", "--workflow", "custom-label"])
        assert args.workflows == ["custom-label"]


class TestDiarizeCommand:
    """Tests for 'diarize' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_diarize_defaults(self, parser):
        """Diarize works with defaults."""
        args = parser.parse_args(["diarize"])
        assert args.command == "diarize"

    def test_diarize_does_not_expose_cross_file_clustering(self, parser):
        """Cross-file speaker matching remains a separate command."""
        with pytest.raises(SystemExit):
            parser.parse_args(["diarize", "--skip-cluster"])

    def test_diarize_workflow_choices(self, parser):
        """Diarize --workflow accepts valid choices."""
        args = parser.parse_args(["diarize", "--workflow", "pyannote"])
        assert args.workflows == ["pyannote"]

    def test_diarize_pyannote_options(self, parser):
        """Diarize accepts pyannote-specific options."""
        args = parser.parse_args(
            [
                "diarize",
                "--pyannote-min-speakers",
                "2",
                "--pyannote-max-speakers",
                "5",
                "--pyannote-clustering-threshold",
                "0.7",
            ]
        )
        assert args.pyannote_min_speakers == 2
        assert args.pyannote_max_speakers == 5
        assert args.pyannote_clustering_threshold == 0.7


class TestExportTranscriptsCommand:
    """Tests for 'export-transcripts' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_export_transcripts_defaults(self, parser):
        """Export-transcripts parses with defaults."""
        args = parser.parse_args(["export-transcripts"])
        assert args.command == "export-transcripts"
        assert args.transcripts_root is None
        assert args.workflow is None
        assert args.model is None
        assert args.stats is False
        assert args.overwrite is False

    def test_export_transcripts_overwrite_flag(self, parser):
        """Export-transcripts accepts --overwrite flag."""
        args = parser.parse_args(["export-transcripts", "--overwrite"])
        assert args.overwrite is True


class TestCheckCommand:
    """Tests for 'check' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_check_defaults(self, parser):
        """Check works with defaults.

        Note: Defaults are None; handler resolves paths from text_data_dir config.
        """
        args = parser.parse_args(["check"])
        assert args.command == "check"
        assert args.csv is None
        assert args.csv_normalized is None

    def test_check_verbose_flag(self, parser):
        """Check accepts -v/--verbose flag."""
        args = parser.parse_args(["check", "-v"])
        assert args.verbose is True

        args = parser.parse_args(["check", "--verbose"])
        assert args.verbose is True

    def test_check_format_choices(self, parser):
        """Check --format accepts valid choices."""
        args = parser.parse_args(["check", "--format", "text"])
        assert args.format == "text"

        args = parser.parse_args(["check", "--format", "json"])
        assert args.format == "json"


class TestClusterSpeakersCommand:
    """Tests for 'cluster-speakers' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_cluster_speakers_defaults(self, parser):
        """Cluster-speakers works with defaults."""
        args = parser.parse_args(["cluster-speakers"])
        assert args.command == "cluster-speakers"
        assert not hasattr(args, "cpu")

    def test_cluster_speakers_rejects_cpu_flag(self, parser):
        """Cluster-speakers no longer exposes --cpu in the catalog CLI."""
        with pytest.raises(SystemExit):
            parser.parse_args(["cluster-speakers", "--cpu"])

    def test_cluster_speakers_model_choices(self, parser):
        """Cluster-speakers --model accepts valid choices."""
        args = parser.parse_args(["cluster-speakers", "--model", "pyannote"])
        assert args.model == "pyannote"

    def test_cluster_speakers_with_hashes(self, parser):
        """Cluster-speakers accepts hash positional arguments."""
        args = parser.parse_args(["cluster-speakers", "abc123", "def456"])
        assert args.hashes == ["abc123", "def456"]

    def test_cluster_speakers_cache_options(self, parser):
        """Cluster-speakers accepts embedding cache options."""
        args = parser.parse_args(
            [
                "cluster-speakers",
                "--embedding-cache-mode",
                "file",
                "--embedding-cache-dir",
                "/cache",
                "--refresh-embedding-cache",
            ]
        )
        assert args.embedding_cache_mode == "file"
        assert args.embedding_cache_dir == Path("/cache")
        assert args.refresh_embedding_cache is True


class TestFindDuplicatesCommand:
    """Tests for 'find-duplicates' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_find_duplicates_defaults(self, parser):
        """Find-duplicates works with defaults."""
        args = parser.parse_args(["find-duplicates"])
        assert args.command == "find-duplicates"
        assert args.directory is None
        assert args.delete is False
        assert args.dry_run is False

    def test_accepts_directory_arg(self, parser):
        """Find-duplicates accepts directory positional argument."""
        args = parser.parse_args(["find-duplicates", "/path/to/scan"])
        assert args.directory == Path("/path/to/scan")

    def test_accepts_catalog_option(self, parser):
        """Find-duplicates accepts --catalog option."""
        args = parser.parse_args(["find-duplicates", "--catalog", "my.csv"])
        assert args.catalog == Path("my.csv")

    def test_delete_flag(self, parser):
        """Find-duplicates accepts --delete flag."""
        args = parser.parse_args(["find-duplicates", "--delete"])
        assert args.delete is True

    def test_dry_run_flag(self, parser):
        """Find-duplicates accepts --dry-run flag."""
        args = parser.parse_args(["find-duplicates", "--delete", "--dry-run"])
        assert args.dry_run is True
        assert args.delete is True

    def test_output_option(self, parser):
        """Find-duplicates accepts --output option."""
        args = parser.parse_args(["find-duplicates", "--output", "dups.csv"])
        assert args.output == Path("dups.csv")

    def test_format_choices(self, parser):
        """Find-duplicates --format accepts valid choices."""
        args = parser.parse_args(["find-duplicates", "--format", "json"])
        assert args.format == "json"

        args = parser.parse_args(["find-duplicates", "--format", "text"])
        assert args.format == "text"


class TestArchiveCommand:
    """Tests for 'archive' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_archive_defaults(self, parser):
        """Archive works with defaults."""
        args = parser.parse_args(["archive"])
        assert args.command == "archive"
        assert args.format == "opus"
        assert args.quality == "low"
        assert args.stereo is False

    def test_format_choices(self, parser):
        """Archive --format accepts valid choices."""
        args = parser.parse_args(["archive", "--format", "opus"])
        assert args.format == "opus"

        args = parser.parse_args(["archive", "--format", "m4a"])
        assert args.format == "m4a"

    def test_quality_choices(self, parser):
        """Archive --quality accepts all valid choices."""
        for quality in ["low", "medium", "high", "max"]:
            args = parser.parse_args(["archive", "--quality", quality])
            assert args.quality == quality

    def test_bitrate_override(self, parser):
        """Archive accepts --bitrate override."""
        args = parser.parse_args(["archive", "--bitrate", "64"])
        assert args.bitrate == 64

    def test_stereo_flag(self, parser):
        """Archive accepts --stereo flag."""
        args = parser.parse_args(["archive", "--stereo"])
        assert args.stereo is True

    def test_parallel_option(self, parser):
        """Archive accepts --parallel option."""
        args = parser.parse_args(["archive", "--parallel", "4"])
        assert args.parallel == 4

    def test_output_dir_option(self, parser):
        """Archive accepts --output-dir option."""
        args = parser.parse_args(["archive", "--output-dir", "/archive"])
        assert args.output_dir == Path("/archive")

    def test_overwrite_flag(self, parser):
        """Archive accepts --overwrite flag."""
        args = parser.parse_args(["archive", "--overwrite"])
        assert args.overwrite is True

    def test_continue_on_error_flag(self, parser):
        """Archive accepts --continue-on-error flag."""
        args = parser.parse_args(["archive", "--continue-on-error"])
        assert args.continue_on_error is True


class TestRunPipelineCommand:
    """Tests for 'run-pipeline' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_run_pipeline_defaults(self, parser):
        """Run-pipeline works with defaults."""
        args = parser.parse_args(["run-pipeline"])
        assert args.command == "run-pipeline"
        assert args.skip_derived is False
        assert args.skip_rag_colbert_index is False
        assert args.continue_on_error is False
        assert args.rag_backend is None
        assert args.rag_all_backends is False
        assert args.rag_colbert_index_dir is None
        assert (
            args.rag_colbert_model is None
        )  # resolved downstream via resolve_default_colbert_model()
        assert args.rag_colbert_doc_maxlen == 384
        assert args.rag_colbert_index_bsize == 32
        assert args.rag_colbert_use_faiss is False
        assert args.rag_colbert_runtime is None
        assert args.rag_min_chunk_tokens == 180
        assert args.rag_max_chunk_tokens == 260
        assert args.rag_overlap_tokens == 40

    def test_skip_derived_flag(self, parser):
        """Run-pipeline accepts --skip-derived flag."""
        args = parser.parse_args(["run-pipeline", "--skip-derived"])
        assert args.skip_derived is True

    def test_skip_rag_colbert_index_flag(self, parser):
        """Run-pipeline accepts --skip-rag-colbert-index flag."""
        args = parser.parse_args(["run-pipeline", "--skip-rag-colbert-index"])
        assert args.skip_rag_colbert_index is True

    def test_continue_on_error_flag(self, parser):
        """Run-pipeline accepts --continue-on-error flag."""
        args = parser.parse_args(["run-pipeline", "--continue-on-error"])
        assert args.continue_on_error is True

    def test_csv_option(self, parser):
        """Run-pipeline accepts --csv option."""
        args = parser.parse_args(["run-pipeline", "--csv", "catalog.csv"])
        assert args.csv == Path("catalog.csv")

    def test_continue_on_error_option(self, parser):
        """Run-pipeline accepts --continue-on-error option."""
        args = parser.parse_args(["run-pipeline", "--continue-on-error"])
        assert args.continue_on_error is True

    def test_rag_options(self, parser):
        """Run-pipeline accepts ColBERT RAG indexing options."""
        args = parser.parse_args(
            [
                "run-pipeline",
                "--skip-rag-colbert-index",
                "--rag-backend",
                "faster-whisper/large-v3@silero_vad_v6",
                "--rag-all-backends",
                "--rag-force",
                "--rag-colbert-index-dir",
                "tmp/rag-colbert",
                "--rag-colbert-model",
                "acme/colbert-demo",
                "--rag-chunk-tokenizer-model",
                "acme/chunk-tokenizer",
                "--rag-colbert-doc-maxlen",
                "512",
                "--rag-colbert-index-bsize",
                "16",
                "--rag-colbert-use-faiss",
                "--rag-colbert-runtime",
                "docker-indexer",
                "--rag-min-chunk-tokens",
                "150",
                "--rag-max-chunk-tokens",
                "250",
                "--rag-overlap-tokens",
                "40",
            ]
        )
        assert args.skip_rag_colbert_index is True
        assert args.rag_backend == "faster-whisper/large-v3@silero_vad_v6"
        assert args.rag_all_backends is True
        assert args.rag_force is True
        assert args.rag_colbert_index_dir == Path("tmp/rag-colbert")
        assert args.rag_colbert_model == "acme/colbert-demo"
        assert args.rag_chunk_tokenizer_model == "acme/chunk-tokenizer"
        assert args.rag_colbert_doc_maxlen == 512
        assert args.rag_colbert_index_bsize == 16
        assert args.rag_colbert_use_faiss is True
        assert args.rag_colbert_runtime == "docker-indexer"
        assert args.rag_min_chunk_tokens == 150
        assert args.rag_max_chunk_tokens == 250
        assert args.rag_overlap_tokens == 40

    def test_run_pipeline_rejects_removed_isolated_colbert_runtime(self, parser):
        """run-pipeline rejects the removed isolated ColBERT runtime alias."""
        with pytest.raises(SystemExit):
            parser.parse_args(["run-pipeline", "--rag-colbert-runtime", "isolated"])


class TestHashCommand:
    """Tests for 'hash' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_hash_defaults(self, parser):
        """Hash works with defaults (no paths)."""
        args = parser.parse_args(["hash"])
        assert args.command == "hash"
        assert args.paths == []
        assert args.csv is None
        assert args.output is None
        assert args.no_sidecar is False
        assert args.no_color is False
        assert args.no_audio_filter is False

    def test_hash_with_paths(self, parser):
        """Hash accepts file and directory paths."""
        args = parser.parse_args(["hash", "/path/to/file.mp3", "/path/to/dir"])
        assert args.paths == [Path("/path/to/file.mp3"), Path("/path/to/dir")]

    def test_hash_output_option(self, parser):
        """Hash accepts --output option."""
        args = parser.parse_args(["hash", "--output", "hashes.csv"])
        assert args.output == Path("hashes.csv")

    def test_hash_output_short_option(self, parser):
        """Hash accepts -o short option."""
        args = parser.parse_args(["hash", "-o", "hashes.csv"])
        assert args.output == Path("hashes.csv")

    def test_hash_csv_option(self, parser):
        """Hash accepts --csv option."""
        args = parser.parse_args(["hash", "--csv", "catalog.csv"])
        assert args.csv == Path("catalog.csv")

    def test_hash_no_sidecar_flag(self, parser):
        """Hash accepts --no-sidecar flag."""
        args = parser.parse_args(["hash", "--no-sidecar"])
        assert args.no_sidecar is True

    def test_hash_no_color_flag(self, parser):
        """Hash accepts --no-color flag."""
        args = parser.parse_args(["hash", "--no-color"])
        assert args.no_color is True

    def test_hash_no_audio_filter_flag(self, parser):
        """Hash accepts --no-audio-filter flag."""
        args = parser.parse_args(["hash", "--no-audio-filter"])
        assert args.no_audio_filter is True

    def test_hash_rejects_removed_raw_file_hash_flag(self, parser):
        """Raw source checksums are not exposed as recording identities."""
        with pytest.raises(SystemExit):
            parser.parse_args(["hash", "--raw-file-hash"])


class TestJoinCommand:
    """Tests for 'join' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_join_requires_paths_and_output(self, parser):
        """Join command requires paths and --output."""
        with pytest.raises(SystemExit):
            parser.parse_args(["join"])
        with pytest.raises(SystemExit):
            parser.parse_args(["join", "file1.mp3"])  # Missing --output

    def test_join_with_paths(self, parser):
        """Join accepts path positional arguments."""
        args = parser.parse_args(["join", "file1.mp3", "file2.mp3", "-o", "out.mp3"])
        assert args.command == "join"
        assert args.paths == [Path("file1.mp3"), Path("file2.mp3")]
        assert args.output == "out.mp3"

    def test_join_output_required(self, parser):
        """Join --output option is required."""
        args = parser.parse_args(["join", "a.mp3", "b.mp3", "--output", "joined.wav"])
        assert args.output == "joined.wav"

    def test_join_output_dir_option(self, parser):
        """Join accepts --output-dir option."""
        args = parser.parse_args(["join", "a.mp3", "-o", "out.mp3", "--output-dir", "/output"])
        assert args.output_dir == Path("/output")

    def test_join_no_fade_flag(self, parser):
        """Join accepts --no-fade flag."""
        args = parser.parse_args(["join", "a.mp3", "-o", "out.mp3", "--no-fade"])
        assert args.no_fade is True

    def test_join_format_choices(self, parser):
        """Join --format accepts valid choices."""
        args = parser.parse_args(["join", "a.mp3", "-o", "out", "--format", "opus"])
        assert args.format == "opus"

    def test_join_force_reencode_flag(self, parser):
        """Join accepts --force-reencode flag."""
        args = parser.parse_args(["join", "a.mp3", "-o", "out.mp3", "--force-reencode"])
        assert args.force_reencode is True

    def test_join_joined_catalog_flag(self, parser):
        """Join accepts --joined-catalog flag."""
        args = parser.parse_args(
            ["join", "a.mp3", "b.mp3", "-o", "out.mp3", "--joined-catalog", "joined.csv"]
        )
        assert args.joined_catalog == Path("joined.csv")

    def test_join_force_join_flag(self, parser):
        """Join accepts --force-join flag."""
        args = parser.parse_args(["join", "a.mp3", "b.mp3", "-o", "out.mp3", "--force-join"])
        assert args.force_join is True

    def test_join_analyze_flag(self, parser):
        """Join accepts --analyze flag."""
        args = parser.parse_args(["join", "a.mp3", "b.mp3", "-o", "out.mp3", "--analyze"])
        assert args.analyze is True

    def test_join_dry_run_flag(self, parser):
        """Join accepts --dry-run flag."""
        args = parser.parse_args(["join", "a.mp3", "-o", "out.mp3", "--dry-run"])
        assert args.dry_run is True

    def test_join_no_move_originals_flag(self, parser):
        """Join accepts --no-move-originals flag."""
        args = parser.parse_args(["join", "a.mp3", "b.mp3", "-o", "out.mp3", "--no-move-originals"])
        assert args.no_move_originals is True


class TestRagColbertIndexCommand:
    """Tests for 'rag-colbert-index' subcommand argument parsing."""

    @pytest.fixture
    def parser(self):
        """Get the argument parser."""
        return build_parser()

    def test_rag_colbert_index_defaults(self, parser):
        """rag-colbert-index parses args with defaults."""
        args = parser.parse_args(["rag-colbert-index", "--group", "wg_123"])
        assert args.command == "rag-colbert-index"
        assert args.group == "wg_123"
        assert args.backend is None
        assert args.model is None  # resolved downstream via resolve_default_colbert_model()
        assert args.chunk_tokenizer_model is None
        assert args.doc_maxlen == 384
        assert args.index_bsize == 32
        assert args.runtime is None
        assert args.use_faiss is False
        assert args.target_audio_hash is None
        assert args.rebuild is False
        assert args.min_chunk_tokens == 180
        assert args.max_chunk_tokens == 260
        assert args.overlap_tokens == 40

    def test_rag_colbert_index_accepts_doc_maxlen(self, parser):
        """rag-colbert-index accepts --doc-maxlen."""
        args = parser.parse_args(["rag-colbert-index", "--group", "wg_123", "--doc-maxlen", "256"])
        assert args.doc_maxlen == 256

    def test_rag_colbert_index_accepts_model_override(self, parser):
        """rag-colbert-index accepts --model override."""
        args = parser.parse_args(
            ["rag-colbert-index", "--group", "wg_123", "--model", "custom/model"]
        )
        assert args.model == "custom/model"

    def test_rag_colbert_index_accepts_index_bsize(self, parser):
        """rag-colbert-index accepts --index-bsize."""
        args = parser.parse_args(["rag-colbert-index", "--group", "wg_123", "--index-bsize", "16"])
        assert args.index_bsize == 16

    def test_rag_colbert_index_accepts_chunk_tokenizer_override(self, parser):
        """rag-colbert-index accepts --chunk-tokenizer-model."""
        args = parser.parse_args(
            [
                "rag-colbert-index",
                "--group",
                "wg_123",
                "--chunk-tokenizer-model",
                "custom/tokenizer",
            ]
        )
        assert args.chunk_tokenizer_model == "custom/tokenizer"

    def test_rag_colbert_index_accepts_runtime_override(self, parser):
        """rag-colbert-index accepts --runtime."""
        args = parser.parse_args(
            ["rag-colbert-index", "--group", "wg_123", "--runtime", "docker-indexer"]
        )
        assert args.runtime == "docker-indexer"

    def test_rag_colbert_index_accepts_target_audio_hash(self, parser):
        """rag-colbert-index accepts --hash."""
        args = parser.parse_args(["rag-colbert-index", "--group", "wg_123", "--hash", "a" * 64])
        assert args.target_audio_hash == "a" * 64

    def test_rag_colbert_index_accepts_rebuild_flag(self, parser):
        """rag-colbert-index accepts --rebuild."""
        args = parser.parse_args(["rag-colbert-index", "--group", "wg_123", "--rebuild"])
        assert args.rebuild is True

    def test_rag_colbert_index_rejects_removed_isolated_runtime_override(self, parser):
        """rag-colbert-index rejects the removed isolated runtime alias."""
        with pytest.raises(SystemExit):
            parser.parse_args(["rag-colbert-index", "--group", "wg_123", "--runtime", "isolated"])


class TestMainFunction:
    """Tests for the main() entry point."""

    def test_main_no_command_returns_error(self):
        """main() with no command returns 1."""
        result = main([])
        assert result == 1

    def test_main_help_does_not_crash(self):
        """main() with --help exits cleanly."""
        with pytest.raises(SystemExit) as exc_info:
            main(["--help"])
        assert exc_info.value.code == 0

    def test_main_subcommand_help_does_not_crash(self):
        """main() with subcommand --help exits cleanly."""
        with pytest.raises(SystemExit) as exc_info:
            main(["create", "--help"])
        assert exc_info.value.code == 0
