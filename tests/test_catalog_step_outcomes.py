"""Per-row failures remain visible to callers without discarding other rows."""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from besedy.commands.catalog import archive, loudness
from besedy.lib.workflow.common import EXIT_ROWS_SKIPPED


def _catalog(tmp_path: Path, source: str, *, analyzed: bool = False) -> Path:
    catalog = tmp_path / "audio_catalog_20260101_120000.csv"
    columns = ["Hash", "Full Path", "Duration", "added_at"]
    row = {"Hash": "a" * 64, "Full Path": source, "Duration": "00:00:01", "added_at": "2026-01-01T00:00:00Z"}
    with catalog.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerow(row)
    if analyzed:
        measurements = {"integrated_loudness_lufs": "-18", "true_peak_db": "-2", "loudness_range_lu": "3", "input_thresh": "-28", "target_offset": "0"}
        columns.extend(measurements)
        row.update(measurements)
        with catalog.with_name(f"{catalog.stem}_loudness.csv").open(
            "w", newline="", encoding="utf-8"
        ) as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerow(row)
    return catalog


@pytest.mark.parametrize("source", ["", "/missing/recording.wav"])
@pytest.mark.parametrize("analyzed", [False, True])
def test_loudness_reports_missing_work_but_accepts_cached_measurements(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str, analyzed: bool
) -> None:
    monkeypatch.setattr(loudness, "check_ffmpeg", lambda *_: True)
    monkeypatch.setattr(loudness, "check_ffprobe", lambda *_: True)
    monkeypatch.setattr(
        loudness, "get_loudness_metrics", lambda *_: pytest.fail("source is unavailable")
    )
    catalog = _catalog(tmp_path, source, analyzed=analyzed)

    result = loudness.handle_loudness(loudness.LoudnessRequest(csv=catalog, no_symlink=True))

    assert result == (0 if analyzed else EXIT_ROWS_SKIPPED)
    with catalog.with_name(f"{catalog.stem}_loudness.csv").open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 1
    assert rows[0]["Hash"] == "a" * 64
    assert rows[0]["integrated_loudness_lufs"] == ("-18" if analyzed else "")


@pytest.mark.parametrize("error", ["decoder failed", None])
def test_loudness_empty_analysis_is_incomplete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: str | None
) -> None:
    source = tmp_path / "recording.wav"
    source.write_bytes(b"not audio")
    catalog = _catalog(tmp_path, str(source))
    monkeypatch.setattr(loudness, "check_ffmpeg", lambda *_: True)
    monkeypatch.setattr(loudness, "check_ffprobe", lambda *_: True)
    monkeypatch.setattr(loudness, "get_loudness_metrics", lambda *_: (None, error))

    assert (
        loudness.handle_loudness(loudness.LoudnessRequest(csv=catalog, no_symlink=True))
        == EXIT_ROWS_SKIPPED
    )


def test_archive_missing_source_reports_incomplete_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(archive, "resolve_audio_executable", lambda binary: str(binary))
    catalog = _catalog(tmp_path, str(tmp_path / "missing.wav"))

    result = archive.handle_archive(
        archive.ArchiveRequest(
            csv=catalog,
            output_dir=tmp_path / "archive",
            no_symlink=True,
            aac_copy=False,
            continue_on_error=True,
        )
    )

    assert result == EXIT_ROWS_SKIPPED
    with catalog.with_name(f"{catalog.stem}_archived.csv").open(newline="") as handle:
        assert list(csv.DictReader(handle)) == []
