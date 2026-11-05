"""Staging publishes validated audio and measures the artifact it actually reuses."""

from __future__ import annotations

import csv
import shutil
import subprocess
from pathlib import Path

import pytest

from besedy.lib.audio import normalize_stage_helpers as stage_helpers
from besedy.lib.audio.normalize import stage_audio_files
from besedy.lib.audio.quality import analyze_audio_file
from besedy.lib.audio.staged_measurements import load_staged_measurements
from besedy.lib.audio.types import ManifestWriter
from besedy.lib.workflow.common import CsvAudioRow
from tests.helpers.audio import create_silent_wav, create_tone_wav

HASH = "a" * 64


def _row(source: Path) -> CsvAudioRow:
    return CsvAudioRow(
        HASH,
        str(source),
        duration_seconds=1.0,
        integrated_loudness_lufs="-40",
        true_peak_db="-20",
        loudness_range_lu="5",
        input_thresh="-50",
        target_offset="0",
    )


@pytest.fixture
def conversion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    source = create_tone_wav(tmp_path / "source.wav")
    staged = create_tone_wav(tmp_path / f"{HASH}.wav", amplitude=0.2)
    previous = staged.read_bytes()

    def decode(_source: Path, output: Path, **_kwargs):
        shutil.copyfile(source, output)
        return True, None

    monkeypatch.setattr(stage_helpers, "decode_to_temp_wav", decode)
    monkeypatch.setattr(stage_helpers.shutil, "which", lambda _binary: "/usr/bin/ffprobe")
    monkeypatch.setattr(
        stage_helpers, "probe_media_duration_seconds", lambda *_args, **_kwargs: (1.0, None)
    )
    return source, staged, previous


@pytest.mark.parametrize("retry_result", ["failed", "truncated", "empty", "short", "success"])
def test_compression_retry_preserves_linear_output_until_validated(
    conversion, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, retry_result: str
) -> None:
    source, staged, previous = conversion
    linear = create_silent_wav(tmp_path / "linear.wav").read_bytes()
    compressed = create_tone_wav(tmp_path / "compressed.wav", amplitude=0.3).read_bytes()
    destinations: list[Path] = []

    def run(cmd, **_kwargs):
        assert staged.read_bytes() == previous
        if "loudnorm=print_format=json" in cmd:
            return subprocess.CompletedProcess(cmd, 0, b"", b'{\n"input_i": "-28"\n}')
        output = Path(cmd[-1])
        assert output != staged
        destinations.append(output)
        if any("linear=false" in arg for arg in cmd):
            if retry_result == "failed":
                output.write_bytes(b"partially overwritten retry")
                return subprocess.CompletedProcess(cmd, 1, b"", b"encoder failed")
            if retry_result == "truncated":
                output.write_bytes(compressed[:-2])
            elif retry_result == "empty":
                create_silent_wav(output, duration_seconds=0)
            elif retry_result == "short":
                create_silent_wav(output, duration_seconds=0.2)
            else:
                output.write_bytes(compressed)
        else:
            output.write_bytes(linear)
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    monkeypatch.setattr(stage_helpers.subprocess, "run", run)

    result = stage_helpers.run_stage_conversion(
        (1, _row(source), source, staged, 1.0),
        ffmpeg_binary="ffmpeg",
        include_audio_analysis=False,
        analysis_ffmpeg_bin="ffmpeg",
        analysis_ffprobe_bin="ffprobe",
        continue_on_error=True,
        aggressive_normalization=True,
        log_notice_state=stage_helpers.ConversionLogNoticeState(None),
    )

    assert result.prepared is not None
    assert result.prepared.staged == staged
    assert result.skipped is None
    assert staged.read_bytes() == (compressed if retry_result == "success" else linear)
    assert len(set(destinations)) == 2
    assert list(tmp_path.glob(".besedy-tmp-*")) == []


@pytest.mark.parametrize("failure", ["encoding", "invalid_output", "interruption"])
def test_overwrite_keeps_previous_audio_when_conversion_fails(
    conversion, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    source, staged, previous = conversion

    def run(cmd, **_kwargs):
        # This also verifies the orchestration has not deleted it preemptively.
        assert staged.read_bytes() == previous
        Path(cmd[-1]).write_bytes(b"partial output")
        if failure == "interruption":
            raise KeyboardInterrupt
        return subprocess.CompletedProcess(cmd, 1 if failure == "encoding" else 0, b"", b"")

    monkeypatch.setattr(stage_helpers.subprocess, "run", run)
    manifest = ManifestWriter(tmp_path / "manifest.csv", include_analysis=False)
    try:
        kwargs = {
            "rows": [_row(source)],
            "staging_dir": tmp_path,
            "manifest_writer": manifest,
            "include_audio_analysis": False,
            "analysis_ffmpeg": "ffmpeg",
            "analysis_ffprobe": "ffprobe",
            "continue_on_error": True,
            "reuse_existing": False,
            "aggressive_normalization": False,
            "protected": {},
        }
        if failure == "interruption":
            with pytest.raises(KeyboardInterrupt):
                stage_audio_files(**kwargs)
        else:
            prepared, skipped = stage_audio_files(**kwargs)
            assert prepared == []
            assert len(skipped) == 1
    finally:
        manifest.close()

    assert staged.read_bytes() == previous
    assert list(tmp_path.glob(".besedy-tmp-*")) == []


@pytest.mark.parametrize("encoding_succeeds", [False, True])
def test_overwrite_replaces_staged_symlink_without_changing_its_target(
    conversion, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, encoding_succeeds: bool
) -> None:
    source, staged, _previous = conversion
    staged.unlink()
    staged.symlink_to(source)
    source_bytes = source.read_bytes()

    def run(cmd, **_kwargs):
        assert staged.is_symlink()
        assert source.read_bytes() == source_bytes
        if encoding_succeeds:
            create_silent_wav(Path(cmd[-1]))
        else:
            Path(cmd[-1]).write_bytes(b"partial output")
        return subprocess.CompletedProcess(cmd, 0 if encoding_succeeds else 1, b"", b"")

    monkeypatch.setattr(stage_helpers.subprocess, "run", run)
    result = stage_helpers.run_stage_conversion(
        (1, _row(source), source, staged, 1.0),
        ffmpeg_binary="ffmpeg",
        include_audio_analysis=False,
        analysis_ffmpeg_bin="ffmpeg",
        analysis_ffprobe_bin="ffprobe",
        continue_on_error=True,
        aggressive_normalization=False,
        log_notice_state=stage_helpers.ConversionLogNoticeState(None),
    )

    assert (result.prepared is not None) == encoding_succeeds
    assert staged.is_symlink() != encoding_succeeds
    assert source.read_bytes() == source_bytes
    assert list(tmp_path.glob(".besedy-tmp-*")) == []


@pytest.mark.integration
def test_incremental_manifest_keeps_measurements_of_normalized_audio(
    tmp_path: Path, require_ffmpeg, monkeypatch: pytest.MonkeyPatch
) -> None:
    if shutil.which("ffprobe") is None:
        pytest.skip("ffprobe not available")
    source = create_tone_wav(tmp_path / "source.wav", amplitude=0.01)
    source_metrics = analyze_audio_file(source)
    row = CsvAudioRow(
        HASH,
        str(source),
        duration_seconds=1.0,
        integrated_loudness_lufs=source_metrics.integrated_loudness_lufs,
        true_peak_db=source_metrics.true_peak_db,
        loudness_range_lu=source_metrics.loudness_range_lu,
        input_thresh=source_metrics.input_thresh,
        target_offset=source_metrics.target_offset,
    )
    staging = tmp_path / "staging"
    staging.mkdir()
    measurements = []
    for reuse_existing in (False, True):
        manifest_path = tmp_path / "normalized.csv"
        cache = load_staged_measurements(manifest_path)
        if reuse_existing:

            def unexpected_analysis(*_args, **_kwargs):
                pytest.fail("unchanged staged audio should reuse its measurements")

            monkeypatch.setattr(stage_helpers, "analyze_audio_file", unexpected_analysis)
        manifest = ManifestWriter(manifest_path, include_analysis=True)
        try:
            prepared, skipped = stage_audio_files(
                [row],
                staging,
                manifest_writer=manifest,
                include_audio_analysis=True,
                analysis_ffmpeg="ffmpeg",
                analysis_ffprobe="ffprobe",
                continue_on_error=False,
                reuse_existing=reuse_existing,
                protected={},
                cached_measurements=cache,
            )
        finally:
            manifest.close()
        assert len(prepared) == 1
        assert skipped == []
        with manifest_path.open(newline="", encoding="utf-8") as handle:
            measurements.append(next(csv.DictReader(handle)))

    first, reused = measurements
    assert -20 <= float(first["integrated_loudness_lufs"]) <= -12
    assert reused["integrated_loudness_lufs"] == first["integrated_loudness_lufs"]
    assert reused["sample_rate"] == first["sample_rate"] == "16000"
    assert reused["channels"] == first["channels"] == "1"
    assert reused["integrated_loudness_lufs"] != source_metrics.integrated_loudness_lufs
