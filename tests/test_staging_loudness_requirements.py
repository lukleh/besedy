"""Only conversions with complete source loudness measurements may be queued."""

from __future__ import annotations

import csv
from dataclasses import replace
from pathlib import Path

import pytest

from besedy.commands.catalog.stage import StageAudioRequest, handle_stage_audio
from besedy.lib.audio import normalize, normalize_stage_helpers
from besedy.lib.audio.types import ConversionResult, ManifestWriter, PreparedEntry
from besedy.lib.correction_guard import ProtectedStagedAudio
from besedy.lib.workflow.common import EXIT_ROWS_SKIPPED, CsvAudioRow
from tests.helpers.audio import create_tone_wav

HASH = "a" * 64
MEASUREMENTS = {
    "integrated_loudness_lufs": "-24",
    "true_peak_db": "-12",
    "loudness_range_lu": "0",
    "input_thresh": "-34",
    "target_offset": "0",
}


def _row(source: Path) -> CsvAudioRow:
    return CsvAudioRow(HASH, str(source), duration_seconds=1.0, **MEASUREMENTS)


def _catalog(tmp_path: Path, rows: list[CsvAudioRow]) -> Path:
    path = tmp_path / "audio_catalog_20260101_120000_loudness.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["Hash", "Full Path", "Duration", *MEASUREMENTS])
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "Hash": row.sha256,
                    "Full Path": row.full_path,
                    "Duration": "00:00:01",
                    **{name: getattr(row, name) for name in MEASUREMENTS},
                }
            )
    return path


@pytest.fixture
def no_audio_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected(*_args, **_kwargs):
        pytest.fail("ineligible or reused audio must not reach source preparation or audio tools")

    monkeypatch.setattr(normalize, "resolve_analysis_binary", unexpected)
    monkeypatch.setattr(normalize_stage_helpers, "decode_to_temp_wav", unexpected)
    monkeypatch.setattr(normalize_stage_helpers.subprocess, "run", unexpected)


@pytest.fixture
def stage_rows(tmp_path: Path):
    def run(rows: list[CsvAudioRow], *, include_analysis: bool = False, **kwargs):
        manifest = ManifestWriter(tmp_path / "manifest.csv", include_analysis=include_analysis)
        try:
            return normalize.stage_audio_files(
                rows,
                tmp_path,
                manifest_writer=manifest,
                include_audio_analysis=include_analysis,
                analysis_ffmpeg="ffmpeg",
                analysis_ffprobe="ffprobe",
                continue_on_error=False,
                protected={},
                **kwargs,
            )
        finally:
            manifest.close()

    return run


@pytest.mark.parametrize("field", MEASUREMENTS)
@pytest.mark.parametrize("missing", [None, "", " \t"])
@pytest.mark.parametrize("include_analysis", [False, True])
def test_missing_measurement_skips_before_source_preparation(
    tmp_path: Path,
    stage_rows,
    no_audio_tools,
    field: str,
    missing: str | None,
    include_analysis: bool,
) -> None:
    source = create_tone_wav(tmp_path / "source.wav")
    row = replace(_row(source), **{field: missing})

    prepared, skipped = stage_rows([row], include_analysis=include_analysis)

    assert prepared == []
    assert len(skipped) == 1
    assert skipped[0].sha256 == HASH
    assert skipped[0].source == source
    assert field in skipped[0].reason
    assert "catalog loudness" in skipped[0].reason
    assert not (tmp_path / f"{HASH}.wav").exists()


@pytest.mark.parametrize("loudness", ["-24", "-inf"])
@pytest.mark.parametrize("with_incomplete_row", [False, True])
def test_complete_measurements_accept_zero_strings_and_silent_loudness(
    tmp_path: Path,
    stage_rows,
    monkeypatch: pytest.MonkeyPatch,
    loudness: str,
    with_incomplete_row: bool,
) -> None:
    source = create_tone_wav(tmp_path / "source.wav")
    row = replace(_row(source), integrated_loudness_lufs=loudness)
    queued: list[CsvAudioRow] = []

    def convert(item, **_kwargs):
        _index, actual, original, staged, duration = item
        queued.append(actual)
        create_tone_wav(staged)
        return ConversionResult(
            PreparedEntry(actual.sha256, original, staged, "convert", duration, True), None, (), ()
        )

    monkeypatch.setattr(normalize, "run_stage_conversion", convert)

    incomplete = replace(row, sha256="b" * 64, true_peak_db=None)
    prepared, skipped = stage_rows([incomplete, row] if with_incomplete_row else [row])

    assert queued == [row]
    assert len(prepared) == 1
    assert [entry.sha256 for entry in skipped] == (
        [incomplete.sha256] if with_incomplete_row else []
    )


@pytest.mark.parametrize("protected", [False, True])
def test_missing_measurements_do_not_prevent_existing_or_protected_reuse(
    tmp_path: Path, no_audio_tools, protected: bool
) -> None:
    source = create_tone_wav(tmp_path / "source.wav")
    staged = create_tone_wav(tmp_path / f"{HASH}.wav")
    previous = staged.read_bytes()
    row = CsvAudioRow(HASH, str(source), duration_seconds=1.0)
    manifest = ManifestWriter(tmp_path / "manifest.csv", include_analysis=True)
    try:
        prepared, skipped = normalize.stage_audio_files(
            [row],
            tmp_path,
            manifest_writer=manifest,
            include_audio_analysis=True,
            analysis_ffmpeg="ffmpeg",
            analysis_ffprobe="ffprobe",
            continue_on_error=True,
            reuse_existing=not protected,
            protected={staged.resolve(): ProtectedStagedAudio(staged, HASH, "workspace", "catalog")}
            if protected
            else {},
        )
    finally:
        manifest.close()

    assert [entry.action for entry in prepared] == ["existing"]
    assert skipped == []
    assert staged.read_bytes() == previous


@pytest.mark.parametrize("skip_analysis", [False, True])
def test_ineligible_overwrite_preserves_previous_wav_but_excludes_it_from_manifest(
    tmp_path: Path, no_audio_tools, capsys, skip_analysis: bool
) -> None:
    source = create_tone_wav(tmp_path / "source.wav")
    staged = create_tone_wav(tmp_path / f"{HASH}.wav")
    previous_audio = staged.read_bytes()
    catalog = _catalog(tmp_path, [replace(_row(source), input_thresh=None)])
    manifest = catalog.with_name(f"{catalog.stem}_normalized.csv")
    manifest.write_text(f"Hash,Full Path\n{HASH},{staged}\n", encoding="utf-8")

    result = handle_stage_audio(
        StageAudioRequest(
            csv=catalog,
            output_dir=tmp_path,
            overwrite=True,
            no_symlink=True,
            skip_audio_analysis=skip_analysis,
        )
    )

    assert result == EXIT_ROWS_SKIPPED
    assert staged.read_bytes() == previous_audio
    with manifest.open(newline="", encoding="utf-8") as handle:
        assert list(csv.DictReader(handle)) == []
    output = capsys.readouterr().out
    assert "Skipped rows: 1" in output
    assert f"{HASH}: missing loudness measurements: input_thresh" in output
    assert "catalog loudness" in output
    assert list(tmp_path.glob(".besedy-tmp-*")) == []


@pytest.mark.parametrize("rows_count", [0, 2])
@pytest.mark.parametrize("skip_analysis", [False, True])
@pytest.mark.parametrize("continue_on_error", [False, True])
def test_empty_and_all_missing_catalogs_report_their_actual_outcome(
    tmp_path: Path,
    no_audio_tools,
    capsys,
    rows_count: int,
    skip_analysis: bool,
    continue_on_error: bool,
) -> None:
    rows = []
    for index in range(rows_count):
        source = create_tone_wav(tmp_path / f"source-{index}.wav")
        rows.append(CsvAudioRow(f"{index:064x}", str(source), duration_seconds=1.0))
    catalog = _catalog(tmp_path, rows)

    result = handle_stage_audio(
        StageAudioRequest(
            csv=catalog,
            output_dir=tmp_path / "staged",
            no_symlink=True,
            continue_on_error=continue_on_error,
            skip_audio_analysis=skip_analysis,
        )
    )

    assert result == (EXIT_ROWS_SKIPPED if rows else 0)
    output = capsys.readouterr().out
    if rows:
        assert "Skipped rows: 2" in output
        for row in rows:
            assert row.sha256 in output
        for field in MEASUREMENTS:
            assert field in output
        assert "catalog loudness --overwrite" in output
        manifest = catalog.with_name(f"{catalog.stem}_normalized.csv")
        with manifest.open(newline="", encoding="utf-8") as handle:
            assert list(csv.DictReader(handle)) == []
