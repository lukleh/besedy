"""Catalog CSVs that are rewritten keep their previous content until the new one is complete.

A crash (OOM, kill, Ctrl-C) or a reader in the middle of a rewrite must see the
old file, never a truncated one: the loudness CSV, the normalized manifest, the
duplicates CSV and every `write_merged_csv` caller (`clean`, `merge`, schema
upgrades) go through a temp file that replaces the original at the end.
"""

from __future__ import annotations

import argparse
import csv
import os
import stat
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from besedy.commands.catalog import add as add_command
from besedy.commands.catalog import loudness as loudness_command
from besedy.commands.catalog import stage as stage_command
from besedy.commands.catalog.file_processing import AddFilesResult
from besedy.commands.catalog.loudness import LoudnessRequest, handle_loudness
from besedy.commands.catalog.stage import StageAudioRequest, handle_stage_audio
from besedy.lib.catalog.manager import AUDIO_HASH_ALGORITHM, FileRecord, write_merged_csv

TS = "20260101_120000"
HASH_A = "a" * 64
HASH_B = "b" * 64


def _write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _temp_files(directory: Path) -> list[Path]:
    return sorted(directory.glob(".besedy-tmp-*"))


class TestWriteMergedCsv:
    def test_failure_mid_write_keeps_previous_file(self, tmp_path: Path) -> None:
        path = tmp_path / f"audio_catalog_{TS}.csv"
        _write_csv(path, ["Hash"], [{"Hash": HASH_A}, {"Hash": HASH_B}])
        before = path.read_bytes()

        def rows():
            yield {"Hash": HASH_A}
            raise RuntimeError("killed mid-write")

        with pytest.raises(RuntimeError, match="killed mid-write"):
            write_merged_csv(path, rows(), columns=["Hash"], encoding="utf-8")

        assert path.read_bytes() == before
        assert _temp_files(tmp_path) == []

    def test_replacement_keeps_file_mode(self, tmp_path: Path) -> None:
        path = tmp_path / f"audio_catalog_{TS}.csv"
        _write_csv(path, ["Hash"], [{"Hash": HASH_A}])
        os.chmod(path, 0o640)

        write_merged_csv(path, [{"Hash": HASH_B}], columns=["Hash"], encoding="utf-8")

        assert _read_rows(path) == [{"Hash": HASH_B}]
        assert stat.S_IMODE(path.stat().st_mode) == 0o640


class TestLoudness:
    @pytest.fixture
    def catalog(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        monkeypatch.setattr(loudness_command, "check_ffprobe", lambda _binary: True)
        monkeypatch.setattr(loudness_command, "check_ffmpeg", lambda _binary: True)
        audio_a = tmp_path / "a.wav"
        audio_b = tmp_path / "b.wav"
        audio_a.write_bytes(b"a")
        audio_b.write_bytes(b"b")
        catalog = tmp_path / f"audio_catalog_{TS}.csv"
        _write_csv(
            catalog,
            ["Hash", "Full Path"],
            [
                {"Hash": HASH_A, "Full Path": str(audio_a)},
                {"Hash": HASH_B, "Full Path": str(audio_b)},
            ],
        )
        # A previous run already measured A; this run only has B to analyze.
        _write_csv(
            tmp_path / f"audio_catalog_{TS}_loudness.csv",
            ["Hash", "Full Path", "integrated_loudness_lufs"],
            [{"Hash": HASH_A, "Full Path": str(audio_a), "integrated_loudness_lufs": "-18.0"}],
        )
        return catalog

    def test_interrupted_run_keeps_previous_loudness_csv(
        self, catalog: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        loudness_csv = catalog.with_name(f"audio_catalog_{TS}_loudness.csv")
        before = loudness_csv.read_bytes()

        def interrupted(*_args):
            raise KeyboardInterrupt

        monkeypatch.setattr(loudness_command, "get_loudness_metrics", interrupted)

        with pytest.raises(KeyboardInterrupt):
            handle_loudness(LoudnessRequest(csv=catalog, parallel=1, no_color=True))

        assert loudness_csv.read_bytes() == before
        assert _temp_files(catalog.parent) == []
        assert not (catalog.parent / "audio_catalog_loudness.csv").is_symlink()

    def test_interrupt_skips_analyses_not_yet_started(
        self, catalog: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        extra_rows = []
        for index in range(6):
            audio = catalog.parent / f"extra{index}.wav"
            audio.write_bytes(b"x")
            extra_rows.append({"Hash": f"{index}" * 64, "Full Path": str(audio)})
        with catalog.open("a", newline="", encoding="utf-8") as handle:
            csv.DictWriter(handle, fieldnames=["Hash", "Full Path"]).writerows(extra_rows)
        calls: list[Path] = []
        queue_cancelled = threading.Event()

        class RecordingExecutor(ThreadPoolExecutor):
            def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
                super().shutdown(wait=wait, cancel_futures=cancel_futures)
                if cancel_futures:
                    queue_cancelled.set()

        def interrupted_after_first(file_path, *_args):
            calls.append(file_path)
            if len(calls) == 1:
                raise KeyboardInterrupt
            # Hold the single worker until the queue is cancelled, so it cannot
            # take another file before that, however slow the main thread is.
            queue_cancelled.wait(timeout=5)
            return None, "no audio stream"

        monkeypatch.setattr(loudness_command, "ThreadPoolExecutor", RecordingExecutor)
        monkeypatch.setattr(loudness_command, "get_loudness_metrics", interrupted_after_first)

        with pytest.raises(KeyboardInterrupt):
            handle_loudness(LoudnessRequest(csv=catalog, parallel=1, no_color=True))

        # The single worker may already have taken the next file; no more.
        assert queue_cancelled.is_set()
        assert len(calls) <= 2

    def test_completed_run_replaces_file_and_points_symlink(
        self, catalog: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        loudness_csv = catalog.with_name(f"audio_catalog_{TS}_loudness.csv")
        monkeypatch.setattr(
            loudness_command, "get_loudness_metrics", lambda *_args: (None, "no audio stream")
        )

        assert handle_loudness(LoudnessRequest(csv=catalog, parallel=1, no_color=True)) == 0

        rows = {row["Hash"]: row for row in _read_rows(loudness_csv)}
        assert set(rows) == {HASH_A, HASH_B}
        assert rows[HASH_A]["integrated_loudness_lufs"] == "-18.0"
        symlink = catalog.parent / "audio_catalog_loudness.csv"
        assert symlink.resolve() == loudness_csv.resolve()


class TestStageAudioManifest:
    @pytest.fixture
    def loudness_csv(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        monkeypatch.setattr(stage_command, "resolve_audio_artifacts_root", lambda: tmp_path)
        monkeypatch.setattr(
            stage_command, "load_audio_rows", lambda *_args, **_kwargs: [SimpleNamespace()]
        )
        path = tmp_path / f"audio_catalog_{TS}_loudness.csv"
        path.write_text("Hash\n", encoding="utf-8")
        _write_csv(
            path.with_name(f"audio_catalog_{TS}_loudness_normalized.csv"),
            ["Hash", "Full Path"],
            [{"Hash": HASH_A, "Full Path": "/staged/a.wav"}],
        )
        return path

    @staticmethod
    def _staging(*, error: BaseException | None):
        def stage_audio_files(_rows, _staging_dir, *, manifest_writer, **_kwargs):
            manifest_writer.write_entry(
                SimpleNamespace(sha256=HASH_B, staged=Path("/staged/b.wav")), size_bytes=1
            )
            if error is not None:
                raise error
            return [], []

        return stage_audio_files

    def test_killed_staging_keeps_previous_manifest(
        self, loudness_csv: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        manifest = loudness_csv.with_name(f"audio_catalog_{TS}_loudness_normalized.csv")
        before = manifest.read_bytes()
        monkeypatch.setattr(
            stage_command, "stage_audio_files", self._staging(error=KeyboardInterrupt())
        )

        request = StageAudioRequest(csv=loudness_csv, output_dir=tmp_path / "staged")
        with pytest.raises(KeyboardInterrupt):
            handle_stage_audio(request)

        assert manifest.read_bytes() == before
        assert _temp_files(tmp_path) == []

    def test_failed_staging_publishes_rows_staged_so_far(
        self, loudness_csv: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # With --overwrite the failed run has already deleted the staged files
        # the previous manifest lists, so that manifest must not survive.
        manifest = loudness_csv.with_name(f"audio_catalog_{TS}_loudness_normalized.csv")
        monkeypatch.setattr(
            stage_command, "stage_audio_files", self._staging(error=RuntimeError("ffmpeg failed"))
        )

        request = StageAudioRequest(
            csv=loudness_csv, output_dir=tmp_path / "staged", overwrite=True
        )
        assert handle_stage_audio(request) == 1

        assert [row["Hash"] for row in _read_rows(manifest)] == [HASH_B]
        assert _temp_files(tmp_path) == []

    def test_completed_staging_replaces_manifest(
        self, loudness_csv: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        manifest = loudness_csv.with_name(f"audio_catalog_{TS}_loudness_normalized.csv")
        monkeypatch.setattr(stage_command, "stage_audio_files", self._staging(error=None))

        request = StageAudioRequest(
            csv=loudness_csv, output_dir=tmp_path / "staged", skip_audio_analysis=True
        )
        assert handle_stage_audio(request) == 0

        assert [row["Hash"] for row in _read_rows(manifest)] == [HASH_B]


class TestAddDuplicates:
    def test_duplicates_csv_keeps_existing_rows_until_merged(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        scan_root = tmp_path / "incoming"
        scan_root.mkdir()
        (scan_root / "copy.wav").write_bytes(b"copy")
        catalog = tmp_path / f"audio_catalog_{TS}.csv"
        _write_csv(
            catalog,
            ["Hash", "Hash Algorithm", "Full Path"],
            [{"Hash": HASH_A, "Hash Algorithm": AUDIO_HASH_ALGORITHM, "Full Path": "/a.wav"}],
        )
        duplicates_csv = catalog.with_name(f"audio_catalog_{TS}_duplicates.csv")
        _write_csv(
            duplicates_csv,
            ["Hash", "Original Path", "Duplicate Path"],
            [{"Hash": HASH_A, "Original Path": "/a.wav", "Duplicate Path": "/old-copy.wav"}],
        )
        before = duplicates_csv.read_bytes()

        duplicate = FileRecord(
            hash=HASH_A,
            filename="copy.wav",
            full_path=scan_root / "copy.wav",
            hash_file=Path(),
            exists=True,
            size_bytes=4,
            size_human="4 B",
            status="duplicate",
            extension=".wav",
        )
        monkeypatch.setattr(
            add_command,
            "add_files_to_catalog",
            lambda **_kwargs: AddFilesResult(
                new_records=[], duplicate_records=[duplicate], errors=[], sidecar_warnings=[]
            ),
        )
        seen_during_write: list[bytes] = []
        real_report = add_command.write_duplicates_report

        def report(*args):
            count = real_report(*args)
            # The new duplicates are written, the existing ones not merged yet.
            seen_during_write.append(duplicates_csv.read_bytes())
            return count

        monkeypatch.setattr(add_command, "write_duplicates_report", report)

        args = argparse.Namespace(
            csv=catalog,
            encoding="utf-8",
            paths=[scan_root],
            skip_enrich=True,
            no_audio_filter=True,
            dry_run=False,
            no_symlink=True,
            ffprobe_binary="ffprobe",
            ffprobe_timeout=10,
            verbose=False,
        )
        assert add_command.handle_add(args) == 0

        assert seen_during_write == [before]
        duplicate_paths = [row["Duplicate Path"] for row in _read_rows(duplicates_csv)]
        assert duplicate_paths == ["/old-copy.wav", str(scan_root / "copy.wav")]
        assert _temp_files(tmp_path) == []
