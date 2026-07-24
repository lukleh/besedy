from __future__ import annotations

import json
from pathlib import Path

from besedy.commands.analyze import (
    cmd_compare,
    cmd_patch_candidates,
    cmd_repetition,
    cmd_validate,
)


def _write_transcript(
    root: Path,
    *,
    backend: str,
    model: str,
    audio_hash: str,
    segments: list[dict],
    duration: float,
) -> None:
    transcript_dir = root / "transcripts" / backend / model / audio_hash
    transcript_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "meta": {
            "duration": duration,
            "audio_filepath": f"/tmp/{audio_hash}.wav",
        },
        "segments": segments,
        "transcript_text": " ".join(seg.get("text", "") for seg in segments),
    }
    (transcript_dir / "transcript.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def _write_raw_transcript(
    root: Path,
    *,
    backend: str,
    model: str,
    audio_hash: str,
    payload: dict,
) -> None:
    transcript_dir = root / "transcripts" / backend / model / audio_hash
    transcript_dir.mkdir(parents=True, exist_ok=True)
    (transcript_dir / "transcript.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def test_validate_reports_warnings_for_bad_timing(tmp_path, monkeypatch):
    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="hash_a",
        duration=5.0,
        segments=[
            {"start": 0.0, "end": 3.0, "text": "hello"},
            {"start": 2.5, "end": 6.2, "text": "overlap and long"},
        ],
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_validate(output_format="json", return_data=True)
    assert data["summary"]["total_files"] == 1
    assert data["summary"]["warning"] + data["summary"]["fail"] == 1
    assert data["files"][0]["issues"]["overlap"] >= 1
    assert data["files"][0]["issues"]["beyond_duration"] >= 1


def test_compare_finds_disagreement_between_models(tmp_path, monkeypatch):
    segments_a = [
        {"start": 0.0, "end": 1.0, "text": "hello world"},
        {"start": 1.0, "end": 2.0, "text": "this is fine"},
    ]
    segments_b = [
        {"start": 0.0, "end": 1.0, "text": "hello world"},
        {"start": 1.0, "end": 2.0, "text": "this is wrong"},
    ]

    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="shared_hash",
        duration=2.0,
        segments=segments_a,
    )
    _write_transcript(
        tmp_path,
        backend="whisperx",
        model="large-v3@silero",
        audio_hash="shared_hash",
        duration=2.0,
        segments=segments_b,
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_compare(output_format="json", return_data=True)
    assert data["summary"]["audio_hashes_compared"] == 1
    comparison = data["comparisons"][0]
    assert comparison["disagreement_intervals"] >= 1
    assert comparison["pairwise_similarity"]


def test_compare_with_min_models_one_handles_empty_pairwise(tmp_path, monkeypatch):
    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="single_model_hash",
        duration=2.0,
        segments=[
            {"start": 0.0, "end": 1.0, "text": "hello"},
            {"start": 1.0, "end": 2.0, "text": "world"},
        ],
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_compare(min_models=1, output_format="json", return_data=True)
    assert data["summary"]["audio_hashes_compared"] == 1
    assert data["summary"]["average_pairwise_similarity"] == 0.0
    assert data["comparisons"][0]["pairwise_similarity"] == []


def test_repetition_flags_repeated_segments(tmp_path, monkeypatch):
    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="repeat_hash",
        duration=4.0,
        segments=[
            {"start": 0.0, "end": 1.0, "text": "ahoj ahoj ahoj ahoj"},
            {"start": 1.0, "end": 2.0, "text": "test test test test"},
            {"start": 2.0, "end": 3.0, "text": "normal sentence"},
        ],
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_repetition(output_format="json", return_data=True)
    assert data["summary"]["flagged_files"] >= 1
    assert data["reports"][0]["severity"] in {"low", "medium", "high"}


def test_repetition_defaults_char_detection_off(tmp_path, monkeypatch):
    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="chars_off_default",
        duration=2.0,
        segments=[
            {"start": 0.0, "end": 2.0, "text": "abababab"},
        ],
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_repetition(output_format="json", return_data=True)
    assert data["summary"]["include_char_repeats"] is False
    assert data["reports"][0]["counts"]["chars"] == 0


def test_repetition_can_enable_character_detection(tmp_path, monkeypatch):
    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="chars_on_enabled",
        duration=2.0,
        segments=[
            {"start": 0.0, "end": 2.0, "text": "abababab"},
        ],
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_repetition(
        output_format="json",
        return_data=True,
        include_char_repeats=True,
    )
    assert data["summary"]["include_char_repeats"] is True
    assert data["reports"][0]["counts"]["chars"] > 0


def test_repetition_skips_invalid_segments_container(tmp_path, monkeypatch):
    _write_raw_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="invalid_segments_container",
        payload={
            "meta": {"duration": 3.0, "audio_filepath": "/tmp/a.wav"},
            "segments": {"not": "a list"},
        },
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_repetition(output_format="json", return_data=True)
    assert data["summary"]["total_files"] == 1
    assert data["summary"]["load_errors"] == 1
    assert data["reports"] == []


def test_repetition_ignores_non_numeric_repeat_span_times(tmp_path, monkeypatch):
    _write_raw_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="invalid_repeat_times",
        payload={
            "meta": {"duration": 3.0, "audio_filepath": "/tmp/a.wav"},
            "segments": [
                {"start": "bad", "end": "oops", "text": "loop"},
                {"start": "still_bad", "end": "nope", "text": "loop"},
            ],
        },
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_repetition(output_format="json", return_data=True)
    assert data["summary"]["total_files"] == 1
    assert data["reports"][0]["repeated_seconds"] == 0.0


def test_repetition_estimates_word_repeat_time_coverage(tmp_path, monkeypatch):
    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="word_repeat_coverage",
        duration=10.0,
        segments=[
            {"start": 0.0, "end": 10.0, "text": "ahoj ahoj ahoj ahoj"},
        ],
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_repetition(output_format="json", return_data=True)
    assert data["summary"]["total_files"] == 1
    assert data["reports"][0]["repeated_seconds"] > 0.0
    assert data["reports"][0]["repeated_coverage"] is not None
    assert data["reports"][0]["repeated_coverage"] > 0.0


def test_repetition_detects_cross_model_shared_hotspots(tmp_path, monkeypatch):
    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="shared_repeat_hash",
        duration=6.0,
        segments=[
            {"start": 0.0, "end": 2.0, "text": "ahoj ahoj ahoj ahoj"},
            {"start": 2.0, "end": 6.0, "text": "normal sentence"},
        ],
    )
    _write_transcript(
        tmp_path,
        backend="whisperx",
        model="large-v3@silero",
        audio_hash="shared_repeat_hash",
        duration=6.0,
        segments=[
            {"start": 0.2, "end": 2.2, "text": "Ahoj, ahoj ahoj ahoj"},
            {"start": 2.2, "end": 6.0, "text": "normal sentence"},
        ],
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_repetition(output_format="json", return_data=True)
    cross = data["cross_model"]
    assert cross["summary"]["audio_hashes_compared"] == 1
    assert cross["summary"]["audio_hashes_with_shared_hotspots"] == 1
    assert cross["summary"]["total_hotspots"] >= 1
    assert cross["by_audio_hash"][0]["audio_hash"] == "shared_repeat_hash"
    assert cross["by_audio_hash"][0]["hotspot_count"] >= 1
    assert cross["by_audio_hash"][0]["hotspots"][0]["model_count"] >= 2
    snippets = cross["by_audio_hash"][0]["top_hotspot_texts"]
    assert "faster-whisper/large-v3" in snippets
    assert "whisperx/large-v3@silero" in snippets
    assert "ahoj" in snippets["faster-whisper/large-v3"].lower()


def test_repetition_cross_model_no_overlap_means_no_shared_hotspot(tmp_path, monkeypatch):
    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="separate_repeat_hash",
        duration=10.0,
        segments=[
            {"start": 0.0, "end": 2.0, "text": "ahoj ahoj ahoj ahoj"},
            {"start": 2.0, "end": 10.0, "text": "normal sentence"},
        ],
    )
    _write_transcript(
        tmp_path,
        backend="whisperx",
        model="large-v3@silero",
        audio_hash="separate_repeat_hash",
        duration=10.0,
        segments=[
            {"start": 0.0, "end": 8.0, "text": "normal sentence"},
            {"start": 8.0, "end": 10.0, "text": "opakuj opakuj opakuj opakuj"},
        ],
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_repetition(output_format="json", return_data=True)
    cross = data["cross_model"]
    assert cross["summary"]["audio_hashes_compared"] == 1
    assert cross["summary"]["audio_hashes_with_shared_hotspots"] == 0
    assert cross["summary"]["total_hotspots"] == 0


def test_repetition_reports_per_model_segment_repetition_rates(tmp_path, monkeypatch):
    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="model_ratio_hash",
        duration=3.0,
        segments=[
            {"start": 0.0, "end": 1.0, "text": "opakuj"},
            {"start": 1.0, "end": 2.0, "text": "opakuj"},
            {"start": 2.0, "end": 3.0, "text": "normal"},
        ],
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_repetition(output_format="json", return_data=True)
    model_rows = data["model_segment_repetition"]
    assert len(model_rows) == 1
    row = model_rows[0]
    assert row["model_key"] == "faster-whisper/large-v3"
    assert row["files"] == 1
    assert row["total_segments"] == 3
    assert row["repeated_segments"] == 2
    assert row["repeated_segment_ratio"] == 0.6667


def test_patch_candidates_suggests_alternative_model(tmp_path, monkeypatch):
    repetitive_segments = [
        {"start": 0.0, "end": 1.0, "text": "ano ano"},
        {"start": 1.0, "end": 2.0, "text": "ano ano"},
        {"start": 2.0, "end": 3.0, "text": "pokračování"},
    ]
    clean_segments = [
        {"start": 0.0, "end": 1.0, "text": "ano"},
        {"start": 1.0, "end": 2.0, "text": "dnes"},
        {"start": 2.0, "end": 3.0, "text": "pokračování"},
    ]

    _write_transcript(
        tmp_path,
        backend="faster-whisper",
        model="large-v3",
        audio_hash="patch_hash",
        duration=3.0,
        segments=repetitive_segments,
    )
    _write_transcript(
        tmp_path,
        backend="whisperx",
        model="large-v3@silero",
        audio_hash="patch_hash",
        duration=3.0,
        segments=clean_segments,
    )

    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))

    data = cmd_patch_candidates(output_format="json", return_data=True)
    assert data["summary"]["total_suggestions"] >= 1
    assert data["suggestions"][0]["best_candidate"]["replacement_model"]
