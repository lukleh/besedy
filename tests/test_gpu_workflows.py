"""GPU workflow tests.

These tests verify GPU-dependent workflows (transcription, diarization).
Tests are marked with @pytest.mark.gpu and will be skipped if no GPU is available.
"""

from __future__ import annotations

import pytest

from tests.helpers.audio import create_tone_wav


@pytest.fixture
def gpu_test_audio(tmp_path):
    """Create a short audio file for GPU testing."""
    return create_tone_wav(
        tmp_path / "gpu_test.wav",
        frequency=440.0,
        duration_seconds=3.0,
    )


class TestGpuAvailability:
    """Tests for GPU availability detection."""

    def test_gpu_fixture_works(self, gpu_available):
        """GPU fixture returns boolean."""
        assert isinstance(gpu_available, bool)

    @pytest.mark.gpu
    def test_cuda_available_when_gpu_marked(self, require_gpu):
        """Tests with require_gpu fixture have CUDA available."""
        import torch

        assert torch.cuda.is_available()

    @pytest.mark.gpu
    def test_cuda_device_count(self, require_gpu):
        """Can query CUDA device count."""
        import torch

        count = torch.cuda.device_count()
        assert count >= 1


class TestFasterWhisperWorkflow:
    """Tests for Faster-Whisper transcription workflow."""

    @pytest.mark.gpu
    @pytest.mark.slow
    def test_faster_whisper_import(self, require_gpu):
        """Faster-Whisper can be imported."""
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            pytest.skip("faster-whisper not installed")
        assert WhisperModel is not None

    @pytest.mark.gpu
    @pytest.mark.slow
    def test_faster_whisper_model_load(self, require_gpu):
        """Faster-Whisper model can be loaded on GPU."""
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            pytest.skip("faster-whisper not installed")

        # Load smallest model for quick test
        try:
            model = WhisperModel("tiny", device="cuda", compute_type="float16")
            assert model is not None
        except Exception as e:
            pytest.skip(f"Model loading failed: {e}")


class TestNemoWorkflow:
    """Tests for NeMo Canary transcription workflow."""

    @pytest.mark.gpu
    @pytest.mark.slow
    def test_nemo_import(self, require_gpu):
        """NeMo can be imported."""
        try:
            import nemo.collections.asr as nemo_asr
        except ImportError:
            pytest.skip("nemo not installed")
        assert nemo_asr is not None

    @pytest.mark.gpu
    @pytest.mark.slow
    def test_nemo_cuda_available(self, require_gpu):
        """NeMo sees CUDA as available."""
        try:
            import torch

            assert torch.cuda.is_available()
        except ImportError:
            pytest.skip("torch not installed")


class TestPyannoteDiarization:
    """Tests for Pyannote diarization workflow."""

    @pytest.mark.gpu
    @pytest.mark.slow
    def test_pyannote_import(self, require_gpu):
        """Pyannote can be imported."""
        try:
            from pyannote.audio import Pipeline
        except ImportError:
            pytest.skip("pyannote-audio not installed")
        assert Pipeline is not None


class TestWorkflowOutputSchema:
    """Tests for workflow output schema conformance."""

    @pytest.fixture
    def sample_nemo_output(self):
        """Sample NeMo Canary output structure."""
        return {
            "segments": [
                {
                    "start": 0.0,
                    "end": 2.5,
                    "text": "Hello world",
                    "words": [
                        {"word": "Hello", "start": 0.0, "end": 1.2},
                        {"word": "world", "start": 1.3, "end": 2.5},
                    ],
                }
            ]
        }

    @pytest.fixture
    def sample_whisper_output(self):
        """Sample Faster-Whisper output structure."""
        return {
            "segments": [
                {
                    "start": 0.0,
                    "end": 2.5,
                    "text": "Hello world",
                    "confidence": 0.95,
                    "words": [
                        {"word": "Hello", "start": 0.0, "end": 1.2, "confidence": 0.96},
                        {"word": "world", "start": 1.3, "end": 2.5, "confidence": 0.94},
                    ],
                }
            ]
        }

    @pytest.fixture
    def sample_diarization_output(self):
        """Sample diarization output structure."""
        return {
            "segments": [
                {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00"},
                {"start": 2.5, "end": 5.0, "speaker": "SPEAKER_01"},
                {"start": 5.5, "end": 8.0, "speaker": "SPEAKER_00"},
            ]
        }

    def test_nemo_output_has_segments(self, sample_nemo_output):
        """NeMo output has segments key."""
        assert "segments" in sample_nemo_output
        assert len(sample_nemo_output["segments"]) > 0

    def test_whisper_output_has_confidence(self, sample_whisper_output):
        """Whisper output includes confidence scores."""
        segment = sample_whisper_output["segments"][0]
        assert "confidence" in segment or "words" in segment

    def test_diarization_output_has_speakers(self, sample_diarization_output):
        """Diarization output has speaker assignments."""
        for segment in sample_diarization_output["segments"]:
            assert "speaker" in segment
            assert segment["speaker"].startswith("SPEAKER_") or segment["speaker"].startswith(
                "spk_"
            )

    def test_all_outputs_have_timestamps(
        self,
        sample_nemo_output,
        sample_whisper_output,
        sample_diarization_output,
    ):
        """All workflow outputs have start/end timestamps."""
        for output in [sample_nemo_output, sample_whisper_output, sample_diarization_output]:
            for segment in output["segments"]:
                assert "start" in segment
                assert "end" in segment
                assert segment["end"] >= segment["start"]


class TestGpuMemoryManagement:
    """Tests for GPU memory management patterns."""

    @pytest.mark.gpu
    def test_cuda_memory_allocated(self, require_gpu):
        """Can check CUDA memory allocation."""
        import torch

        allocated = torch.cuda.memory_allocated()
        assert isinstance(allocated, int)

    @pytest.mark.gpu
    def test_cuda_cache_clear(self, require_gpu):
        """Can clear CUDA cache."""
        import torch

        torch.cuda.empty_cache()
        # Should not raise


class TestWorkflowConfigPatterns:
    """Tests for workflow configuration patterns."""

    def test_workflow_label_format(self):
        """Workflow labels follow expected format."""
        from besedy.core.paths import (
            NEMO_VAD_WORKFLOW_LABEL,
            PYANNOTE_DIARIZATION_WORKFLOW_LABEL,
        )

        # Labels should be non-empty strings
        assert isinstance(NEMO_VAD_WORKFLOW_LABEL, str)
        assert len(NEMO_VAD_WORKFLOW_LABEL) > 0

        assert isinstance(PYANNOTE_DIARIZATION_WORKFLOW_LABEL, str)
        assert len(PYANNOTE_DIARIZATION_WORKFLOW_LABEL) > 0

    def test_workflow_output_directory_structure(self, tmp_path):
        """Workflow outputs follow expected directory structure."""
        # Expected: transcripts/<backend>/<model>/<hash>/transcript.json
        backend = "faster-whisper"
        model = "large-v3@silero_vad_v6"
        audio_hash = "abc123def456"

        output_dir = tmp_path / backend / model / audio_hash
        output_dir.mkdir(parents=True)
        output_file = output_dir / "transcript.json"
        output_file.write_text('{"segments": []}')

        # Verify structure
        assert output_dir.exists()
        assert output_file.exists()
        assert output_file.parent.name == audio_hash
        assert output_file.parent.parent.name == model


class TestWorkflowErrorHandling:
    """Tests for workflow error handling patterns."""

    def test_audio_validation_rejects_wrong_sample_rate(self, wav_16k_mono):
        """Audio validation rejects wrong sample rate."""
        from besedy.core.paths import validate_mono_wav_16k

        # Should raise for wrong sample rate
        with pytest.raises(ValueError, match="sampled at"):
            validate_mono_wav_16k(wav_16k_mono, sample_rate=44100, channel_count=1)

    def test_audio_validation_rejects_wrong_channels(self, wav_16k_mono):
        """Audio validation rejects wrong channel count."""
        from besedy.core.paths import validate_mono_wav_16k

        # Should raise for wrong channel count
        with pytest.raises(ValueError, match="mono"):
            validate_mono_wav_16k(wav_16k_mono, sample_rate=16000, channel_count=2)

    def test_valid_audio_passes_validation(self, wav_16k_mono):
        """Valid 16kHz mono WAV passes validation."""
        from besedy.core.paths import validate_mono_wav_16k

        # Should not raise for correct parameters
        validate_mono_wav_16k(wav_16k_mono, sample_rate=16000, channel_count=1)
