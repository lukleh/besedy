"""Tests for besedy/workflows/transcribe_faster_whisper.py.

Tests cover:
- Argument parsing
- VAD segment extraction
- Payload building
- File path resolution
- Output schema compliance

Note: Integration tests requiring actual model loading are marked with
@pytest.mark.gpu and @pytest.mark.integration.

The faster-whisper library is installed in an isolated environment, so
we mock its imports for testing in the main venv.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# Mock faster_whisper before importing the module
mock_faster_whisper = MagicMock()
sys.modules["faster_whisper"] = mock_faster_whisper
sys.modules["faster_whisper.vad"] = MagicMock()

from besedy.workflows import transcribe_faster_whisper as transcribe_module  # noqa: E402
from besedy.workflows.transcribe_faster_whisper import (  # noqa: E402
    build_payload,
    ensure_audio_files,
    parse_args,
    resolve_bundle_root,
    resolve_model_reference,
)


class TestParseArgs:
    """Tests for argument parsing."""

    def test_minimal_args(self):
        """Test parsing with only required --audio argument."""
        with patch("sys.argv", ["prog", "--audio", "/path/to/audio.wav"]):
            args = parse_args()
            assert args.audio == [Path("/path/to/audio.wav")]

    def test_multiple_audio_files(self):
        """Test parsing multiple audio files."""
        with patch(
            "sys.argv",
            ["prog", "--audio", "/path/a.wav", "/path/b.wav", "/path/c.wav"],
        ):
            args = parse_args()
            assert len(args.audio) == 3

    def test_custom_model(self):
        """Test custom model specification."""
        with patch("sys.argv", ["prog", "--audio", "/path/a.wav", "--model", "medium"]):
            args = parse_args()
            assert args.model == "medium"

    def test_device_options(self):
        """Test device specification."""
        with patch("sys.argv", ["prog", "--audio", "/path/a.wav", "--device", "cpu"]):
            args = parse_args()
            assert args.device == "cpu"

    def test_batch_size(self):
        """Test batch size argument."""
        with patch("sys.argv", ["prog", "--audio", "/path/a.wav", "--batch-size", "16"]):
            args = parse_args()
            assert args.batch_size == 16

    def test_language_override(self):
        """Test language specification."""
        with patch("sys.argv", ["prog", "--audio", "/path/a.wav", "--language", "en"]):
            args = parse_args()
            assert args.language == "en"

    def test_output_dir_specification(self):
        """Test output directory argument."""
        with patch(
            "sys.argv",
            ["prog", "--audio", "/path/a.wav", "--output-dir", "/custom/output"],
        ):
            args = parse_args()
            assert args.output_dir == Path("/custom/output")


@pytest.mark.parametrize(
    ("configured_language", "cli_language"),
    [("auto", None), ("cs", "auto")],
    ids=("configured-auto", "cli-auto"),
)
def test_main_maps_auto_language_to_none_for_inference(
    configured_language: str,
    cli_language: str | None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / f"{'a' * 64}.wav"
    audio_path.touch()
    bundle_root = tmp_path / "bundle"
    bundle_root.mkdir()
    captured: dict[str, object] = {}

    class DummyPipeline:
        def transcribe(self, _audio_path: str, **kwargs: object):
            captured["inference_language"] = kwargs["language"]
            info = SimpleNamespace(language="en", transcription_options=None)
            return iter(()), info

    pipeline = DummyPipeline()

    def fake_build_payload(_audio_path: Path, **kwargs: object) -> dict[str, object]:
        captured["payload_language"] = kwargs["language"]
        return {"meta": {}, "segments": []}

    default_config = SimpleNamespace(
        model_name="large-v3",
        vad_model="silero_vad_v6",
        language=configured_language,
    )
    monkeypatch.setattr(
        transcribe_module,
        "select_transcription_workflow",
        lambda *_args, **_kwargs: default_config,
    )
    monkeypatch.setattr(
        transcribe_module, "resolve_bundle_root", lambda *_args, **_kwargs: bundle_root
    )
    monkeypatch.setattr(transcribe_module, "resolve_model_reference", lambda model: model)
    monkeypatch.setattr(transcribe_module, "WhisperModel", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(
        transcribe_module,
        "BatchedInferencePipeline",
        lambda *, model: pipeline,
    )
    monkeypatch.setattr(transcribe_module, "extract_vad_segments", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(transcribe_module, "build_payload", fake_build_payload)

    argv = ["prog", "--audio", str(audio_path), "--device", "cpu"]
    if cli_language is not None:
        argv.extend(["--language", cli_language])
    monkeypatch.setattr(sys, "argv", argv)

    assert transcribe_module.main() == 0
    assert captured == {
        "inference_language": None,
        "payload_language": None,
    }


class TestEnsureAudioFiles:
    """Tests for audio file validation."""

    def test_existing_files_resolved(self, tmp_path):
        """Test that existing files are resolved to absolute paths."""
        audio_file = tmp_path / "test.wav"
        audio_file.touch()

        result = ensure_audio_files([audio_file])
        assert len(result) == 1
        assert result[0].is_absolute()
        assert result[0].exists()

    def test_nonexistent_file_raises(self, tmp_path):
        """Test that missing files raise FileNotFoundError."""
        missing = tmp_path / "missing.wav"
        with pytest.raises(FileNotFoundError, match="Audio file not found"):
            ensure_audio_files([missing])

    def test_multiple_files_all_resolved(self, tmp_path):
        """Test resolving multiple audio files."""
        files = [tmp_path / f"audio{i}.wav" for i in range(3)]
        for f in files:
            f.touch()

        result = ensure_audio_files(files)
        assert len(result) == 3
        assert all(p.exists() for p in result)


class TestResolveModelReference:
    """Tests for model reference resolution."""

    def test_huggingface_alias_passthrough(self):
        """HF aliases should be returned unchanged."""
        assert resolve_model_reference("large-v3") == "large-v3"

    def test_huggingface_repo_passthrough(self):
        """HF repo IDs should be returned unchanged when not local paths."""
        model_id = "openai/whisper-large-v3"
        assert resolve_model_reference(model_id) == model_id

    def test_absolute_local_model_path_resolved(self, tmp_path):
        """Absolute local model paths should resolve to absolute strings."""
        local_model = tmp_path / "whisper-large-v3-czech-cv13-ct2"
        local_model.mkdir()

        resolved = resolve_model_reference(str(local_model))
        assert resolved == str(local_model.resolve())

    def test_missing_absolute_local_model_path_raises(self, tmp_path):
        """Missing absolute local model path should fail with clear error."""
        missing_model = tmp_path / "missing-local-model"
        with pytest.raises(FileNotFoundError, match="Local faster-whisper model path not found"):
            resolve_model_reference(str(missing_model))

    def test_existing_relative_local_model_path_resolved(self, tmp_path, monkeypatch):
        """Existing relative paths should resolve to absolute local model paths."""
        monkeypatch.chdir(tmp_path)
        local_model = Path("models/ct2-local")
        local_model.mkdir(parents=True)

        resolved = resolve_model_reference("models/ct2-local")
        assert resolved == str((tmp_path / "models" / "ct2-local").resolve())


class TestResolveBundleRoot:
    """Tests for output directory resolution."""

    def test_default_output_dir(self, tmp_path, monkeypatch):
        """Test default output directory structure."""
        # Mock the config paths
        monkeypatch.setattr(
            "besedy.workflows.transcribe_faster_whisper.resolve_transcripts_root",
            lambda x=None: tmp_path / "transcripts",
        )

        result = resolve_bundle_root(None, "large-v3", language="cs")
        assert "faster-whisper" in str(result) or "large-v3" in str(result)

    def test_language_component_lands_in_output_dir(self, tmp_path, monkeypatch):
        """Non-Czech languages get their own output component; cs keeps legacy paths."""
        monkeypatch.setattr(
            "besedy.workflows.transcribe_faster_whisper.resolve_transcripts_root",
            lambda x=None: tmp_path / "transcripts",
        )

        legacy = resolve_bundle_root(None, "large-v3", "silero_vad_v6", language="cs")
        automatic = resolve_bundle_root(None, "large-v3", "silero_vad_v6", language="auto")
        assert legacy.name == "large-v3@silero_vad_v6"
        assert automatic.name == "large-v3@silero_vad_v6@lang-auto"

    def test_custom_output_dir(self, tmp_path, monkeypatch):
        """Test custom output directory is respected."""
        custom_dir = tmp_path / "custom_output"
        custom_dir.mkdir()

        monkeypatch.setattr(
            "besedy.workflows.transcribe_faster_whisper.resolve_project_path",
            lambda x: Path(x).expanduser().resolve(),
        )

        result = resolve_bundle_root(custom_dir, "large-v3", language="cs")
        assert str(custom_dir) in str(result) or result.exists()


class TestExtractVadSegments:
    """Tests for VAD segment extraction.

    These tests require the faster-whisper isolated environment.
    """

    @pytest.mark.integration
    @pytest.mark.skip(reason="Requires faster-whisper isolated environment")
    def test_vad_segments_structure(self, wav_16k_mono):
        """Test VAD segments have correct structure."""
        from besedy.workflows.transcribe_faster_whisper import extract_vad_segments

        segments = extract_vad_segments(wav_16k_mono)

        # For silent audio, may return empty list
        assert isinstance(segments, list)
        for seg in segments:
            assert "start" in seg
            assert "end" in seg
            assert isinstance(seg["start"], float)
            assert isinstance(seg["end"], float)
            assert seg["end"] >= seg["start"]

    @pytest.mark.integration
    @pytest.mark.skip(reason="Requires faster-whisper isolated environment")
    def test_vad_with_tone(self, wav_with_tone):
        """Test VAD detects speech-like audio."""
        from besedy.workflows.transcribe_faster_whisper import extract_vad_segments

        segments = extract_vad_segments(wav_with_tone)

        # Tone should be detected as speech
        assert isinstance(segments, list)
        # Note: Tone may or may not trigger VAD depending on threshold


class TestBuildPayload:
    """Tests for transcript payload building."""

    def test_basic_payload_structure(self, tmp_path):
        """Test that payload has required structure."""
        audio_path = tmp_path / "test.wav"
        audio_path.touch()

        # Mock segment object
        mock_segment = MagicMock()
        mock_segment.start = 0.0
        mock_segment.end = 2.5
        mock_segment.text = "Hello world"
        mock_segment.words = []
        mock_segment.avg_logprob = -0.5

        # Mock info object
        mock_info = MagicMock()
        mock_info.language = "cs"
        mock_info.language_probability = 0.99
        mock_info.duration = 2.5
        mock_info.duration_after_vad = 2.0
        mock_info.transcription_options = None

        with patch(
            "besedy.workflows.transcribe_faster_whisper.measure_audio_duration_seconds",
            return_value=2.5,
        ):
            payload = build_payload(
                audio_path,
                model_name="large-v3",
                device="cuda",
                compute_type="float16",
                language="cs",
                batch_size=8,
                vad_filter=True,
                min_silence_ms=500,
                word_timestamps=True,
                info=mock_info,
                segments=[mock_segment],
            )

        # Check required keys
        assert "meta" in payload
        assert "segments" in payload

        # Check meta structure
        meta = payload["meta"]
        assert meta["backend"] == "faster-whisper"
        assert meta["model"] == "large-v3"
        assert "audio_filepath" in meta
        assert "duration" in meta
        assert "num_segments" in meta
        assert "num_words" in meta
        assert "transcript_text" in meta
        assert "generation_params" in meta

    def test_segments_payload_structure(self, tmp_path):
        """Test segment payload structure."""
        audio_path = tmp_path / "test.wav"
        audio_path.touch()

        # Mock segment with words
        mock_word = MagicMock()
        mock_word.word = "Hello"
        mock_word.start = 0.0
        mock_word.end = 0.5
        mock_word.probability = 0.95

        mock_segment = MagicMock()
        mock_segment.start = 0.0
        mock_segment.end = 2.5
        mock_segment.text = "Hello"
        mock_segment.words = [mock_word]
        mock_segment.avg_logprob = -0.3

        mock_info = MagicMock()
        mock_info.language = "cs"
        mock_info.language_probability = 0.99
        mock_info.duration = 2.5
        mock_info.duration_after_vad = None
        mock_info.transcription_options = None

        with patch(
            "besedy.workflows.transcribe_faster_whisper.measure_audio_duration_seconds",
            return_value=2.5,
        ):
            payload = build_payload(
                audio_path,
                model_name="large-v3",
                device="cuda",
                compute_type="float16",
                language="cs",
                batch_size=8,
                vad_filter=True,
                min_silence_ms=500,
                word_timestamps=True,
                info=mock_info,
                segments=[mock_segment],
            )

        # Check segments structure
        segments = payload["segments"]
        assert len(segments) == 1
        seg = segments[0]
        assert "start" in seg
        assert "end" in seg
        assert "text" in seg
        assert "confidence" in seg
        assert "words" in seg

        # Check word structure
        words = seg["words"]
        assert len(words) == 1
        word = words[0]
        assert "start" in word
        assert "end" in word
        assert "word" in word
        assert "confidence" in word

    def test_vad_segments_included_when_provided(self, tmp_path):
        """Test VAD segments are included in payload."""
        audio_path = tmp_path / "test.wav"
        audio_path.touch()

        mock_segment = MagicMock()
        mock_segment.start = 0.0
        mock_segment.end = 2.5
        mock_segment.text = "Test"
        mock_segment.words = []
        mock_segment.avg_logprob = -0.5

        mock_info = MagicMock()
        mock_info.language = "cs"
        mock_info.language_probability = 0.99
        mock_info.duration = 2.5
        mock_info.duration_after_vad = None
        mock_info.transcription_options = None

        vad_segments = [
            {"start": 0.1, "end": 2.4},
            {"start": 3.0, "end": 5.0},
        ]

        with patch(
            "besedy.workflows.transcribe_faster_whisper.measure_audio_duration_seconds",
            return_value=5.5,
        ):
            payload = build_payload(
                audio_path,
                model_name="large-v3",
                device="cuda",
                compute_type="float16",
                language="cs",
                batch_size=8,
                vad_filter=True,
                min_silence_ms=500,
                word_timestamps=True,
                info=mock_info,
                segments=[mock_segment],
                vad_segments=vad_segments,
            )

        assert "vad_segments" in payload
        assert payload["vad_segments"] == vad_segments

    def test_empty_text_handling(self, tmp_path):
        """Test handling of segments with empty text."""
        audio_path = tmp_path / "test.wav"
        audio_path.touch()

        mock_segment = MagicMock()
        mock_segment.start = 0.0
        mock_segment.end = 1.0
        mock_segment.text = ""
        mock_segment.words = []
        mock_segment.avg_logprob = None

        mock_info = MagicMock()
        mock_info.language = "cs"
        mock_info.language_probability = 0.99
        mock_info.duration = 1.0
        mock_info.duration_after_vad = None
        mock_info.transcription_options = None

        with patch(
            "besedy.workflows.transcribe_faster_whisper.measure_audio_duration_seconds",
            return_value=1.0,
        ):
            payload = build_payload(
                audio_path,
                model_name="large-v3",
                device="cuda",
                compute_type="float16",
                language="cs",
                batch_size=8,
                vad_filter=True,
                min_silence_ms=500,
                word_timestamps=True,
                info=mock_info,
                segments=[mock_segment],
            )

        assert payload["meta"]["transcript_text"] == ""
        assert payload["segments"][0]["text"] == ""

    def test_monotonic_timestamps_enforced(self, tmp_path):
        """Test that overlapping timestamps are corrected."""
        audio_path = tmp_path / "test.wav"
        audio_path.touch()

        # Create overlapping segments
        seg1 = MagicMock()
        seg1.start = 0.0
        seg1.end = 2.0
        seg1.text = "First"
        seg1.words = []
        seg1.avg_logprob = -0.3

        seg2 = MagicMock()
        seg2.start = 1.5  # Overlaps with seg1
        seg2.end = 3.0
        seg2.text = "Second"
        seg2.words = []
        seg2.avg_logprob = -0.4

        mock_info = MagicMock()
        mock_info.language = "cs"
        mock_info.language_probability = 0.99
        mock_info.duration = 3.0
        mock_info.duration_after_vad = None
        mock_info.transcription_options = None

        with patch(
            "besedy.workflows.transcribe_faster_whisper.measure_audio_duration_seconds",
            return_value=3.0,
        ):
            payload = build_payload(
                audio_path,
                model_name="large-v3",
                device="cuda",
                compute_type="float16",
                language="cs",
                batch_size=8,
                vad_filter=True,
                min_silence_ms=500,
                word_timestamps=True,
                info=mock_info,
                segments=[seg1, seg2],
            )

        segments = payload["segments"]
        # Second segment should be adjusted to not overlap
        assert segments[1]["start"] >= segments[0]["end"]


class TestOutputSchemaCompliance:
    """Tests for canonical output schema compliance."""

    def test_payload_is_json_serializable(self, tmp_path):
        """Test that generated payload can be serialized to JSON."""
        audio_path = tmp_path / "test.wav"
        audio_path.touch()

        mock_word = MagicMock()
        mock_word.word = "Test"
        mock_word.start = 0.0
        mock_word.end = 0.5
        mock_word.probability = 0.9

        mock_segment = MagicMock()
        mock_segment.start = 0.0
        mock_segment.end = 1.0
        mock_segment.text = "Test"
        mock_segment.words = [mock_word]
        mock_segment.avg_logprob = -0.5

        mock_info = MagicMock()
        mock_info.language = "cs"
        mock_info.language_probability = 0.99
        mock_info.duration = 1.0
        mock_info.duration_after_vad = None
        mock_info.transcription_options = None

        with patch(
            "besedy.workflows.transcribe_faster_whisper.measure_audio_duration_seconds",
            return_value=1.0,
        ):
            payload = build_payload(
                audio_path,
                model_name="large-v3",
                device="cuda",
                compute_type="float16",
                language="cs",
                batch_size=8,
                vad_filter=True,
                min_silence_ms=500,
                word_timestamps=True,
                info=mock_info,
                segments=[mock_segment],
            )

        # Should not raise
        json_str = json.dumps(payload, ensure_ascii=False, indent=2)
        assert json_str

        # Should roundtrip
        parsed = json.loads(json_str)
        assert parsed == payload

    def test_timestamp_precision(self, tmp_path):
        """Test that timestamps have appropriate precision."""
        audio_path = tmp_path / "test.wav"
        audio_path.touch()

        mock_word = MagicMock()
        mock_word.word = "Test"
        mock_word.start = 0.123456789
        mock_word.end = 0.987654321
        mock_word.probability = 0.9

        mock_segment = MagicMock()
        mock_segment.start = 0.123456789
        mock_segment.end = 1.987654321
        mock_segment.text = "Test"
        mock_segment.words = [mock_word]
        mock_segment.avg_logprob = -0.5

        mock_info = MagicMock()
        mock_info.language = "cs"
        mock_info.language_probability = 0.99
        mock_info.duration = 2.0
        mock_info.duration_after_vad = None
        mock_info.transcription_options = None

        with patch(
            "besedy.workflows.transcribe_faster_whisper.measure_audio_duration_seconds",
            return_value=2.0,
        ):
            payload = build_payload(
                audio_path,
                model_name="large-v3",
                device="cuda",
                compute_type="float16",
                language="cs",
                batch_size=8,
                vad_filter=True,
                min_silence_ms=500,
                word_timestamps=True,
                info=mock_info,
                segments=[mock_segment],
            )

        seg = payload["segments"][0]
        # Timestamps should be rounded to 6 decimal places
        assert len(str(seg["start"]).split(".")[-1]) <= 6
        assert len(str(seg["end"]).split(".")[-1]) <= 6

        word = seg["words"][0]
        assert len(str(word["start"]).split(".")[-1]) <= 6
        assert len(str(word["end"]).split(".")[-1]) <= 6


@pytest.mark.gpu
@pytest.mark.integration
class TestGpuIntegration:
    """Integration tests requiring GPU and models."""

    def test_full_transcription_pipeline(self, wav_with_tone):
        """Test full transcription pipeline on real audio."""
        # This test requires:
        # - GPU
        # - faster-whisper model downloaded

        # Would need to mock sys.argv and run main()
        # Skip for now as it requires model download
        pytest.skip("Requires model download - run manually")
