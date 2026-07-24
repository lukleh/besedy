"""Tests for the one-off faster-whisper transcription CLI."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from besedy.cli import transcribe_oneoff
from besedy.cli.transcribe_oneoff import (
    MissingFasterWhisperRuntimeError,
    OneOffDefaults,
    OutputPaths,
    ensure_audio_files,
    parse_args,
    render_sidecars,
    resolve_output_paths,
    write_sidecars,
)


def _sample_payload(audio_path: Path) -> dict:
    return {
        "meta": {
            "backend": "faster-whisper",
            "model": "large-v3",
            "audio_filepath": str(audio_path),
            "duration": 1.2,
            "num_segments": 1,
            "num_words": 2,
            "transcript_text": "Ahoj svete",
            "generation_params": {},
        },
        "segments": [
            {
                "start": 0.0,
                "end": 1.2,
                "text": "Ahoj svete",
                "confidence": 0.9,
                "words": [
                    {"start": 0.0, "end": 0.5, "word": "Ahoj", "confidence": 0.9},
                    {"start": 0.5, "end": 1.2, "word": "svete", "confidence": 0.9},
                ],
            }
        ],
    }


def test_parse_args_minimal() -> None:
    args = parse_args(["/tmp/audio.mp3"])

    assert args.audio == [Path("/tmp/audio.mp3")]
    assert args.suffix == ".transcript"
    assert args.json_only is False
    assert args.language is None


def test_ensure_audio_files_resolves_existing_file(tmp_path: Path) -> None:
    audio = tmp_path / "recording.mp3"
    audio.touch()

    result = ensure_audio_files([audio])

    assert result == [audio.resolve()]


def test_resolve_output_paths_default_next_to_audio(tmp_path: Path) -> None:
    audio = tmp_path / "recording.mp3"

    paths = resolve_output_paths(audio)

    assert paths.json == tmp_path / "recording.transcript.json"
    assert paths.txt == tmp_path / "recording.transcript.txt"
    assert paths.srt == tmp_path / "recording.transcript.srt"
    assert paths.vtt == tmp_path / "recording.transcript.vtt"


def test_resolve_output_paths_custom_output_dir_and_suffix(tmp_path: Path) -> None:
    audio = tmp_path / "recording.mp3"
    out_dir = tmp_path / "out"

    paths = resolve_output_paths(audio, output_dir=out_dir, suffix="fw")

    assert paths.json == out_dir / "recording.fw.json"
    assert paths.txt == out_dir / "recording.fw.txt"


def test_render_sidecars_from_canonical_payload(tmp_path: Path) -> None:
    rendered = render_sidecars(_sample_payload(tmp_path / "recording.mp3"))

    assert rendered["txt"] == "Ahoj svete\n"
    assert "00:00:00,000 --> 00:00:01,200" in rendered["srt"]
    assert rendered["vtt"].startswith("WEBVTT\n")


def test_write_sidecars_creates_txt_srt_vtt(tmp_path: Path) -> None:
    audio = tmp_path / "recording.mp3"
    paths = OutputPaths(
        json=tmp_path / "recording.transcript.json",
        txt=tmp_path / "recording.transcript.txt",
        srt=tmp_path / "recording.transcript.srt",
        vtt=tmp_path / "recording.transcript.vtt",
    )
    paths.json.write_text(json.dumps(_sample_payload(audio)), encoding="utf-8")

    written = write_sidecars(_sample_payload(audio), paths, overwrite=False)

    assert written == [paths.txt, paths.srt, paths.vtt]
    assert paths.txt.read_text(encoding="utf-8") == "Ahoj svete\n"
    assert paths.srt.exists()
    assert paths.vtt.exists()


def test_main_reuses_existing_json_without_loading_runtime(tmp_path: Path, monkeypatch) -> None:
    audio = tmp_path / "recording.mp3"
    audio.touch()
    json_path = tmp_path / "recording.transcript.json"
    json_path.write_text(json.dumps(_sample_payload(audio)), encoding="utf-8")

    def fail_runtime_load():
        pytest.fail("faster-whisper runtime should not load when JSON already exists")

    monkeypatch.setattr(transcribe_oneoff, "_load_faster_whisper_helpers", fail_runtime_load)
    monkeypatch.setattr(transcribe_oneoff, "resolve_defaults", lambda: OneOffDefaults())

    result = transcribe_oneoff.main([str(audio)])

    assert result == 0
    assert (tmp_path / "recording.transcript.txt").read_text(encoding="utf-8") == "Ahoj svete\n"


def test_main_rejects_duplicate_output_paths(tmp_path: Path, monkeypatch) -> None:
    source_a = tmp_path / "a"
    source_b = tmp_path / "b"
    source_a.mkdir()
    source_b.mkdir()
    audio_a = source_a / "same.mp3"
    audio_b = source_b / "same.wav"
    audio_a.touch()
    audio_b.touch()
    output_dir = tmp_path / "out"

    monkeypatch.setattr(transcribe_oneoff, "resolve_defaults", lambda: OneOffDefaults())

    result = transcribe_oneoff.main([str(audio_a), str(audio_b), "--output-dir", str(output_dir)])

    assert result == 1


def test_main_transcribes_with_mocked_faster_whisper_runtime(
    tmp_path: Path,
    monkeypatch,
) -> None:
    audio = tmp_path / "recording.mp3"
    audio.touch()
    calls: dict[str, object] = {}

    class DummyModel:
        def __init__(self, model_reference: str, *, device: str, compute_type: str) -> None:
            calls["model_reference"] = model_reference
            calls["device"] = device
            calls["compute_type"] = compute_type

    class DummySegment:
        start = 0.0
        end = 1.2
        text = "Ahoj svete"
        words: list[object] = []
        avg_logprob = -0.1

    class DummyInfo:
        language = "cs"
        language_probability = 0.99
        duration = 1.2
        duration_after_vad = 1.2
        transcription_options = None

    class DummyPipeline:
        def __init__(self, model: DummyModel) -> None:
            calls["pipeline_model"] = model

        def transcribe(self, audio_path: str, **kwargs: object):
            calls["audio_path"] = audio_path
            calls["transcribe_kwargs"] = kwargs
            return iter([DummySegment()]), DummyInfo()

    def build_payload(audio_path: Path, **kwargs: object) -> dict:
        calls["build_payload_kwargs"] = kwargs
        return _sample_payload(audio_path)

    helpers = SimpleNamespace(
        resolve_model_reference=lambda model_name: f"resolved:{model_name}",
        WhisperModel=DummyModel,
        BatchedInferencePipeline=DummyPipeline,
        extract_vad_segments=lambda _path, min_silence_duration_ms=None, sampling_rate=None: [
            {"start": 0.0, "end": 1.2}
        ],
        build_payload=build_payload,
    )

    monkeypatch.setattr(transcribe_oneoff, "_load_faster_whisper_helpers", lambda: helpers)
    monkeypatch.setattr(
        transcribe_oneoff,
        "resolve_defaults",
        lambda: OneOffDefaults(
            model_name="large-v3",
            vad_model="silero_vad_v6",
            vad_filter=True,
            word_timestamps=True,
            min_silence_ms=500,
        ),
    )

    result = transcribe_oneoff.main([str(audio), "--device", "cpu", "--compute-type", "int8"])

    assert result == 0
    assert calls["model_reference"] == "resolved:large-v3"
    assert calls["device"] == "cpu"
    assert calls["compute_type"] == "int8"
    assert Path(calls["audio_path"]) == audio.resolve()
    assert calls["transcribe_kwargs"]["vad_filter"] is True
    assert calls["transcribe_kwargs"]["word_timestamps"] is True
    # Without --language and without a configured workflow, the one-off CLI
    # keeps the historical forced-Czech default.
    assert calls["transcribe_kwargs"]["language"] == "cs"
    assert (tmp_path / "recording.transcript.json").exists()
    assert (tmp_path / "recording.transcript.txt").read_text(encoding="utf-8") == "Ahoj svete\n"


def test_main_auto_falls_back_to_docker_when_host_runtime_is_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    audio = tmp_path / "recording.mp3"
    audio.touch()
    captured: dict[str, object] = {}

    def missing_runtime():
        raise MissingFasterWhisperRuntimeError("missing faster-whisper")

    def fake_docker(args, *, audio_files, outputs, model_name):
        captured["runtime"] = args.runtime
        captured["audio_files"] = audio_files
        captured["outputs"] = outputs
        captured["model_name"] = model_name
        return 23

    monkeypatch.setattr(transcribe_oneoff, "_load_faster_whisper_helpers", missing_runtime)
    monkeypatch.setattr(transcribe_oneoff, "run_in_faster_whisper_docker", fake_docker)
    monkeypatch.setattr(transcribe_oneoff, "resolve_defaults", lambda: OneOffDefaults())

    result = transcribe_oneoff.main([str(audio)])

    assert result == 23
    assert captured["runtime"] == "auto"
    assert captured["audio_files"] == [audio.resolve()]
    assert captured["model_name"] == "large-v3"


def test_main_runtime_docker_bypasses_host_runtime(
    tmp_path: Path,
    monkeypatch,
) -> None:
    audio = tmp_path / "recording.mp3"
    audio.touch()

    def fail_runtime_load():
        pytest.fail("host faster-whisper runtime should not load when --runtime docker is set")

    monkeypatch.setattr(transcribe_oneoff, "_load_faster_whisper_helpers", fail_runtime_load)
    monkeypatch.setattr(
        transcribe_oneoff,
        "run_in_faster_whisper_docker",
        lambda args, *, audio_files, outputs, model_name: 0,
    )
    monkeypatch.setattr(transcribe_oneoff, "resolve_defaults", lambda: OneOffDefaults())

    result = transcribe_oneoff.main([str(audio), "--runtime", "docker"])

    assert result == 0
