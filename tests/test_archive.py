"""Tests for the archive command module."""

from __future__ import annotations

import csv
import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

from besedy.commands.catalog import archive as archive_module
from besedy.commands.catalog.archive import (
    M4A_VBR_MODES,
    OPUS_BITRATES,
    OPUS_SUPPORTED_RATES,
    ArchivedManifestWriter,
    ArchiveRequest,
    ArchiveSkippedEntry,
    CompressedEntry,
    aac_vbr_mode,
    compress_audio_file,
    compute_output_path,
    handle_archive,
    load_archived_hashes,
    migrate_manifest_header,
    nearest_opus_sample_rate,
    update_manifest_rows,
)
from besedy.lib.workflow.common import CsvAudioRow


class TestNearestOpusSampleRate:
    """Tests for Opus sample rate rounding."""

    def test_exact_supported_rates_unchanged(self):
        """Exact Opus-supported rates should remain unchanged."""
        for rate in OPUS_SUPPORTED_RATES:
            assert nearest_opus_sample_rate(rate) == rate

    def test_44100_caps_at_24000(self):
        """44.1kHz (CD quality) should cap at 24kHz for speech."""
        assert nearest_opus_sample_rate(44100) == 24000

    def test_22050_rounds_to_24000(self):
        """22.05kHz should round to 24kHz."""
        assert nearest_opus_sample_rate(22050) == 24000

    def test_11025_rounds_to_12000(self):
        """11.025kHz should round to 12kHz."""
        assert nearest_opus_sample_rate(11025) == 12000

    def test_high_rates_cap_at_24000(self):
        """Rates above 24kHz should cap at 24kHz for speech."""
        assert nearest_opus_sample_rate(48000) == 24000
        assert nearest_opus_sample_rate(96000) == 24000
        assert nearest_opus_sample_rate(192000) == 24000

    def test_very_low_rates_floor_at_8000(self):
        """Very low rates should floor at 8kHz."""
        assert nearest_opus_sample_rate(4000) == 8000
        assert nearest_opus_sample_rate(6000) == 8000

    def test_boundary_cases(self):
        """Test boundary values between supported rates."""
        # Between 8000 and 12000 - boundary at 10000
        assert nearest_opus_sample_rate(9000) == 8000
        assert nearest_opus_sample_rate(11000) == 12000

        # Between 12000 and 16000 - boundary at 14000
        assert nearest_opus_sample_rate(13000) == 12000
        assert nearest_opus_sample_rate(15000) == 16000

        # Between 16000 and 24000 - boundary at 20000
        assert nearest_opus_sample_rate(18000) == 16000
        assert nearest_opus_sample_rate(22000) == 24000

        # Above 24000 - caps at 24000 for speech
        assert nearest_opus_sample_rate(30000) == 24000
        assert nearest_opus_sample_rate(40000) == 24000


class TestComputeOutputPath:
    """Tests for output path computation."""

    def test_preserves_directory_structure(self):
        """Output path should preserve source directory structure with hash suffix."""
        source = Path("/data/podcasts/2024/episode1.mp3")
        source_root = Path("/data")
        output_dir = Path("/archive")
        sha256 = "abc12345def67890"
        result = compute_output_path(source, source_root, output_dir, ".webm", sha256)

        # Hash suffix (first 8 chars) is added to filename
        assert result == Path("/archive/podcasts/2024/episode1_abc12345.webm")

    def test_changes_extension(self):
        """Output should have the new extension."""
        source = Path("/audio/file.mp3")
        source_root = Path("/audio")
        output_dir = Path("/out")
        sha256 = "abc12345def67890"

        webm_result = compute_output_path(source, source_root, output_dir, ".webm", sha256)
        assert webm_result.suffix == ".webm"

        m4a_result = compute_output_path(source, source_root, output_dir, ".m4a", sha256)
        assert m4a_result.suffix == ".m4a"

    def test_handles_deep_paths(self):
        """Should handle deeply nested paths."""
        source = Path("/a/b/c/d/e/f/file.wav")
        source_root = Path("/a")
        output_dir = Path("/out")
        sha256 = "abc12345def67890"
        result = compute_output_path(source, source_root, output_dir, ".webm", sha256)

        assert result == Path("/out/b/c/d/e/f/file_abc12345.webm")

    def test_handles_spaces_in_path(self):
        """Should handle paths with spaces."""
        source = Path("/my files/podcast episodes/episode 1.mp3")
        source_root = Path("/my files")
        output_dir = Path("/archive")
        sha256 = "abc12345def67890"
        result = compute_output_path(source, source_root, output_dir, ".webm", sha256)

        assert result == Path("/archive/podcast episodes/episode 1_abc12345.webm")
        assert "podcast episodes" in str(result)
        assert result.name == "episode 1_abc12345.webm"


class TestArchivedManifestWriter:
    """Tests for the CSV manifest writer."""

    def test_writes_header(self):
        """Manifest should have correct header row."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            path = Path(f.name)

        try:
            writer = ArchivedManifestWriter(path)
            writer.close()

            with open(path, "r", encoding="utf-8") as f:
                reader = csv.reader(f)
                header = next(reader)

            expected = [
                "Hash",
                "Original Path",
                "Compressed Path",
                "Format",
                "Bitrate (kbps)",
                "Original Size (bytes)",
                "Compressed Size (bytes)",
                "Compression Ratio",
                "Duration",
                "added_at",
                "Compressed AAC Path",
                "Compressed AAC Size (bytes)",
                "Compressed AAC Bitrate (kbps)",
            ]
            assert header == expected
        finally:
            path.unlink(missing_ok=True)

    def test_writes_entry(self):
        """Should write entry data correctly."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            path = Path(f.name)

        try:
            writer = ArchivedManifestWriter(path)

            entry = CompressedEntry(
                sha256="abc123",
                source=Path("/src/file.mp3"),
                compressed=Path("/out/file.webm"),
                format="opus",
                bitrate_kbps=48,
                source_size_bytes=1000000,
                compressed_size_bytes=500000,
                compression_ratio=2.0,
                duration_seconds=3661,  # 1:01:01
            )
            writer.write_entry(entry)
            writer.close()

            with open(path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                row = next(reader)

            assert row["Hash"] == "abc123"
            assert row["Original Path"] == "/src/file.mp3"
            assert row["Compressed Path"] == "/out/file.webm"
            assert row["Format"] == "opus"
            assert row["Bitrate (kbps)"] == "48"
            assert row["Original Size (bytes)"] == "1000000"
            assert row["Compressed Size (bytes)"] == "500000"
            assert row["Compression Ratio"] == "2.0"
            assert row["Duration"] == "01:01:01"
        finally:
            path.unlink(missing_ok=True)


class TestLoadArchivedHashes:
    """Tests for reading the existing archived manifest."""

    def test_missing_file_returns_empty_set(self, tmp_path):
        """A missing manifest is a normal first run."""
        assert load_archived_hashes(tmp_path / "missing_archived.csv") == set()

    def test_empty_file_returns_empty_set(self, tmp_path):
        """A manifest with no header has nothing to lose."""
        path = tmp_path / "catalog_archived.csv"
        path.write_text("", encoding="utf-8")
        assert load_archived_hashes(path) == set()

    def test_reads_hashes(self, tmp_path):
        """Hashes are read, and blank lines and blank Hash cells are ignored."""
        path = tmp_path / "catalog_archived.csv"
        path.write_text("Hash,Original Path\nabc,/a.mp3\n\n,/b.mp3\n", encoding="utf-8")
        assert load_archived_hashes(path) == {"abc"}

    def test_unreadable_file_raises_with_path(self, tmp_path):
        """A manifest that exists but cannot be decoded must not read as empty."""
        path = tmp_path / "catalog_archived.csv"
        path.write_bytes(b"Hash,Original Path\nabc,/\xff.mp3\n")
        with pytest.raises(ValueError, match="catalog_archived.csv"):
            load_archived_hashes(path)

    @pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
    def test_inaccessible_parent_raises(self, tmp_path):
        """A permission error is a clear error with the path, not a traceback or 'missing'."""
        catalog_dir = tmp_path / "catalog"
        catalog_dir.mkdir()
        path = catalog_dir / "catalog_archived.csv"
        path.write_text("Hash\nabc\n", encoding="utf-8")
        catalog_dir.chmod(0)
        try:
            with pytest.raises(ValueError, match="catalog_archived.csv"):
                load_archived_hashes(path)
        finally:
            catalog_dir.chmod(0o700)

    def test_header_without_hash_column_raises(self, tmp_path):
        """A BOM or damaged header hides the Hash column and must not read as empty."""
        path = tmp_path / "catalog_archived.csv"
        path.write_text("\ufeffHash,Original Path\nabc,/a.mp3\n", encoding="utf-8")
        with pytest.raises(ValueError, match="no 'Hash' column"):
            load_archived_hashes(path)


class TestHandleArchiveUnreadableManifest:
    """handle_archive must stop before touching an unreadable manifest."""

    def test_exits_nonzero_and_leaves_manifest_unchanged(self, tmp_path, capsys, monkeypatch):
        monkeypatch.setenv("BESEDY_AUDIO_ARTIFACTS_ROOT", str(tmp_path / "artifacts"))
        source_csv = tmp_path / "audio_catalog_20260101_000000_loudness.csv"
        source_csv.write_text(
            "Hash,Full Path,Duration\nabc,/src/a.mp3,00:01:00\n", encoding="utf-8"
        )
        archived_csv = tmp_path / "audio_catalog_20260101_000000_loudness_archived.csv"
        original = b"Hash,Original Path\nabc,/\xff.mp3\n"
        archived_csv.write_bytes(original)

        result = handle_archive(ArchiveRequest(csv=source_csv, no_symlink=True))

        assert result == 1
        assert archived_csv.read_bytes() == original
        assert str(archived_csv) in capsys.readouterr().err


class TestDataclasses:
    """Tests for dataclass definitions."""

    def test_compressed_entry_immutable(self):
        """CompressedEntry should be immutable (frozen)."""
        entry = CompressedEntry(
            sha256="abc",
            source=Path("/a"),
            compressed=Path("/b"),
            format="opus",
            bitrate_kbps=48,
            source_size_bytes=100,
            compressed_size_bytes=50,
            compression_ratio=2.0,
            duration_seconds=60,
        )
        with pytest.raises(AttributeError):
            entry.sha256 = "xyz"

    def test_skipped_entry_immutable(self):
        """ArchiveSkippedEntry should be immutable (frozen)."""
        entry = ArchiveSkippedEntry(
            sha256="abc",
            source=Path("/a"),
            reason="test reason",
        )
        with pytest.raises(AttributeError):
            entry.reason = "new reason"


class TestConstants:
    """Tests for module constants."""

    def test_opus_bitrates_has_all_presets(self):
        """OPUS_BITRATES should have all quality presets."""
        assert set(OPUS_BITRATES.keys()) == {"low", "medium", "high", "max"}

    def test_opus_bitrates_ascending(self):
        """Bitrates should increase with quality."""
        assert OPUS_BITRATES["low"] < OPUS_BITRATES["medium"]
        assert OPUS_BITRATES["medium"] < OPUS_BITRATES["high"]
        assert OPUS_BITRATES["high"] < OPUS_BITRATES["max"]

    def test_m4a_vbr_modes_has_all_presets(self):
        """M4A_VBR_MODES should have all quality presets."""
        assert set(M4A_VBR_MODES.keys()) == {"low", "medium", "high", "max"}

    def test_opus_supported_rates_sorted(self):
        """OPUS_SUPPORTED_RATES should be sorted ascending."""
        assert OPUS_SUPPORTED_RATES == sorted(OPUS_SUPPORTED_RATES)

    def test_opus_supported_rates_values(self):
        """OPUS_SUPPORTED_RATES should be capped at 24kHz for speech archiving."""
        assert OPUS_SUPPORTED_RATES == [8000, 12000, 16000, 24000]


OLD_HEADER = [
    "Hash",
    "Original Path",
    "Compressed Path",
    "Format",
    "Bitrate (kbps)",
    "Original Size (bytes)",
    "Compressed Size (bytes)",
    "Compression Ratio",
    "Duration",
    "added_at",
]


def _write_rows(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader.fieldnames or []), list(reader)


def _entry(sha256: str, **aac: object) -> CompressedEntry:
    return CompressedEntry(
        sha256=sha256,
        source=Path(f"/src/{sha256}.mp3"),
        compressed=Path(f"/out/{sha256}.webm"),
        format="opus",
        bitrate_kbps=48,
        source_size_bytes=1000,
        compressed_size_bytes=100,
        compression_ratio=10.0,
        duration_seconds=60,
        **aac,  # type: ignore[arg-type]
    )


class TestManifestMigration:
    """Manifests written before the AAC columns keep working."""

    def test_writes_aac_columns(self, tmp_path):
        path = tmp_path / "archived.csv"
        writer = ArchivedManifestWriter(path)
        writer.write_entry(
            _entry("abc", aac_path=Path("/out/abc.m4a"), aac_size_bytes=120, aac_bitrate_kbps=16)
        )
        writer.write_entry(_entry("def"))
        writer.close()

        _, rows = _read_rows(path)
        assert rows[0]["Compressed AAC Path"] == "/out/abc.m4a"
        assert rows[0]["Compressed AAC Size (bytes)"] == "120"
        assert rows[0]["Compressed AAC Bitrate (kbps)"] == "16"
        assert rows[1]["Compressed AAC Path"] == ""

    def test_append_to_an_old_manifest_rewrites_its_header_first(self, tmp_path):
        """Appending with more columns than the header would shift every value."""
        path = tmp_path / "archived.csv"
        _write_rows(path, OLD_HEADER, [{"Hash": "old", "Compressed Path": "/out/old.webm"}])

        writer = ArchivedManifestWriter(path, append=True)
        writer.write_entry(_entry("new", aac_path=Path("/out/new.m4a"), aac_size_bytes=5))
        writer.close()

        header, rows = _read_rows(path)
        assert header == ArchivedManifestWriter.FIELDNAMES
        assert rows[0]["Hash"] == "old"
        assert rows[0]["Compressed Path"] == "/out/old.webm"
        assert rows[0]["Compressed AAC Path"] == ""
        assert rows[1]["Hash"] == "new"
        assert rows[1]["Compressed AAC Path"] == "/out/new.m4a"

    def test_migration_keeps_unknown_columns_and_skips_current_files(self, tmp_path):
        path = tmp_path / "archived.csv"
        _write_rows(path, OLD_HEADER + ["Note"], [{"Hash": "a", "Note": "keep me"}])

        header = migrate_manifest_header(path)
        assert header[: len(OLD_HEADER) + 1] == OLD_HEADER + ["Note"]
        assert _read_rows(path)[1][0]["Note"] == "keep me"

        before = path.stat().st_mtime_ns
        os.utime(path, ns=(before - 10_000_000, before - 10_000_000))
        stamped = path.stat().st_mtime_ns
        migrate_manifest_header(path)
        assert path.stat().st_mtime_ns == stamped  # already current: not rewritten

    def test_update_rows_sets_columns_by_hash(self, tmp_path):
        path = tmp_path / "archived.csv"
        _write_rows(path, OLD_HEADER, [{"Hash": "a"}, {"Hash": "b", "Format": "opus"}])

        changed = update_manifest_rows(path, {"b": {"Compressed AAC Path": "/out/b.m4a"}})

        header, rows = _read_rows(path)
        assert changed == 1
        assert "Compressed AAC Path" in header
        assert rows[0]["Compressed AAC Path"] == ""
        assert rows[1]["Compressed AAC Path"] == "/out/b.m4a"
        assert rows[1]["Format"] == "opus"
        assert not (tmp_path / ".archived.csv.tmp").exists()


class TestAacQuality:
    """VBR modes for the m4a format."""

    def test_vbr_mode_never_exceeds_the_source(self):
        assert aac_vbr_mode("max", None) == M4A_VBR_MODES["max"]
        assert aac_vbr_mode("max", 40) == 3
        assert aac_vbr_mode("max", 64) == 4
        assert aac_vbr_mode("low", 40) == M4A_VBR_MODES["low"]


def _tone(path: Path, seconds: int = 6) -> Path:
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", f"sine=frequency=440:duration={seconds}:sample_rate=44100",
            "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", str(path),
        ],
        check=True,
    )
    return path


def _probe(path: Path) -> dict[str, str]:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration,format_name:stream=codec_name",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    data = json.loads(out)
    return {
        "duration": data["format"]["duration"],
        "format": data["format"]["format_name"],
        "codec": data["streams"][0]["codec_name"],
    }


@pytest.mark.integration
class TestAacCopyEncoding:
    """Real ffmpeg: the copy is AAC in MP4 and lines up with the Opus archive."""

    def _row(self, source: Path) -> CsvAudioRow:
        return CsvAudioRow(sha256="c" * 64, full_path=str(source), duration_seconds=6.0)

    def test_writes_opus_and_aac_with_matching_durations(self, tmp_path, require_ffmpeg):
        source = _tone(tmp_path / "talk.mp3")
        output = tmp_path / "out" / "talk_cccccccc.webm"
        aac = output.with_suffix(".m4a")

        result = compress_audio_file(
            self._row(source),
            output,
            format="opus",
            quality="medium",
            stereo=False,
            ffmpeg_binary="ffmpeg",
            ffprobe_binary="ffprobe",
            use_fdk=False,
            aac_output_path=aac,
        )

        assert result.skipped is None, result.skipped
        entry = result.compressed
        assert entry is not None
        assert entry.aac_path == aac
        assert entry.aac_size_bytes == aac.stat().st_size
        assert entry.aac_bitrate_kbps and entry.aac_bitrate_kbps > 0
        opus, copy = _probe(output), _probe(aac)
        assert (opus["codec"], copy["codec"]) == ("opus", "aac")
        assert "mp4" in copy["format"]
        # Transcripts and saved positions are shared: the timelines must agree.
        assert abs(float(opus["duration"]) - float(copy["duration"])) < 0.05

    @pytest.mark.parametrize("quality, bitrate", [("low", None), ("max", 96)])
    def test_copy_uses_the_fixed_vbr_mode_whatever_the_opus_settings(
        self, tmp_path, require_ffmpeg, monkeypatch, quality, bitrate
    ):
        source = _tone(tmp_path / "talk.mp3", seconds=2)
        output = tmp_path / "out" / "talk.webm"
        modes: list[int] = []
        original = archive_module._encode_m4a

        def spy(*args, **kwargs):  # type: ignore[no-untyped-def]
            modes.append(kwargs["vbr_mode"])
            return original(*args, **kwargs)

        monkeypatch.setattr(archive_module, "_encode_m4a", spy)
        result = compress_audio_file(
            self._row(source),
            output,
            format="opus",
            quality=quality,
            stereo=False,
            ffmpeg_binary="ffmpeg",
            ffprobe_binary="ffprobe",
            use_fdk=False,
            bitrate_override=bitrate,
            aac_output_path=output.with_suffix(".m4a"),
        )

        assert result.compressed is not None
        assert modes == [archive_module.AAC_COPY_VBR_MODE]

    def test_backfill_uses_the_fixed_vbr_mode(self, tmp_path, require_ffmpeg, monkeypatch):
        source = _tone(tmp_path / "talk.mp3", seconds=2)
        webm = tmp_path / "out" / "talk.webm"
        webm.parent.mkdir()
        webm.write_bytes(b"opus")
        modes: list[int] = []
        original = archive_module._encode_m4a

        def spy(*args, **kwargs):  # type: ignore[no-untyped-def]
            modes.append(kwargs["vbr_mode"])
            return original(*args, **kwargs)

        monkeypatch.setattr(archive_module, "_encode_m4a", spy)
        result = archive_module.backfill_aac_copy(
            self._row(source),
            webm,
            stereo=False,
            ffmpeg_binary="ffmpeg",
            ffprobe_binary="ffprobe",
            use_fdk=False,
        )

        assert result.values is not None
        assert webm.with_suffix(".m4a").is_file()
        assert modes == [archive_module.AAC_COPY_VBR_MODE]

    def test_a_failed_copy_keeps_the_opus_archive(self, tmp_path, require_ffmpeg, monkeypatch):
        source = _tone(tmp_path / "talk.mp3", seconds=2)
        output = tmp_path / "out" / "talk.webm"
        monkeypatch.setattr(archive_module, "_encode_m4a", lambda *a, **k: (3, "ffmpeg failed: boom"))

        result = compress_audio_file(
            self._row(source),
            output,
            format="opus",
            quality="low",
            stereo=False,
            ffmpeg_binary="ffmpeg",
            ffprobe_binary="ffprobe",
            use_fdk=False,
            aac_output_path=output.with_suffix(".m4a"),
        )

        # The recording stays archived and playable; only the copy is missing,
        # and the blank AAC columns let --backfill-aac retry it.
        assert result.skipped is None
        assert result.compressed is not None
        assert result.compressed.aac_path is None
        assert result.warning is not None and result.warning.startswith("aac copy")
        assert output.is_file()


@pytest.mark.integration
class TestArchiveAndBackfill:
    """handle_archive writes the copy, and --backfill-aac adds it later."""

    def _catalog(self, tmp_path: Path, monkeypatch) -> tuple[Path, Path]:  # type: ignore[no-untyped-def]
        monkeypatch.setenv("BESEDY_AUDIO_ARTIFACTS_ROOT", str(tmp_path / "artifacts"))
        (tmp_path / "media").mkdir()
        source = _tone(tmp_path / "media" / "talk.mp3", seconds=3)
        loudness = tmp_path / "audio_catalog_20260101_000000_loudness.csv"
        loudness.write_text(
            f"Hash,Full Path,Duration\n{'d' * 64},{source},00:00:03\n", encoding="utf-8"
        )
        return loudness, loudness.with_name(f"{loudness.stem}_archived.csv")

    def test_archive_writes_both_files(self, tmp_path, require_ffmpeg, monkeypatch):
        loudness, archived = self._catalog(tmp_path, monkeypatch)

        assert handle_archive(ArchiveRequest(csv=loudness, no_symlink=True)) == 0

        _, rows = _read_rows(archived)
        webm, m4a = Path(rows[0]["Compressed Path"]), Path(rows[0]["Compressed AAC Path"])
        assert webm.suffix == ".webm" and webm.is_file()
        assert m4a == webm.with_suffix(".m4a") and m4a.is_file()
        assert rows[0]["Compressed AAC Size (bytes)"] == str(m4a.stat().st_size)

    def test_no_aac_then_backfill(self, tmp_path, require_ffmpeg, monkeypatch):
        loudness, archived = self._catalog(tmp_path, monkeypatch)
        assert handle_archive(ArchiveRequest(csv=loudness, no_symlink=True, aac_copy=False)) == 0
        _, rows = _read_rows(archived)
        webm = Path(rows[0]["Compressed Path"])
        assert rows[0]["Compressed AAC Path"] == ""
        assert not webm.with_suffix(".m4a").exists()

        request = ArchiveRequest(csv=loudness, no_symlink=True, backfill_aac=True)
        assert handle_archive(request) == 0

        _, rows = _read_rows(archived)
        assert rows[0]["Compressed AAC Path"] == str(webm.with_suffix(".m4a"))
        assert webm.with_suffix(".m4a").is_file()
        assert rows[0]["Compressed Path"] == str(webm)  # the Opus row is otherwise unchanged

        # Nothing left to do on a second run.
        stamp = archived.stat().st_mtime_ns
        assert handle_archive(request) == 0
        assert archived.stat().st_mtime_ns == stamp


class TestBackfillSafety:
    """Backfill selection, locking and manifest writes."""

    def _manifest(self, tmp_path: Path, rows: list[dict[str, str]]) -> Path:
        path = tmp_path / "audio_catalog_20260101_000000_loudness_archived.csv"
        _write_rows(path, OLD_HEADER, rows)
        return path

    def test_selects_each_hash_once_and_only_webm_archives(self, tmp_path):
        webm = tmp_path / "a.webm"
        webm.write_bytes(b"x")
        m4a_archive = tmp_path / "b.m4a"
        m4a_archive.write_bytes(b"x")
        rows = [
            CsvAudioRow(sha256="a" * 64, full_path=str(tmp_path / "a.mp3")),
            CsvAudioRow(sha256="b" * 64, full_path=str(tmp_path / "b.mp3")),
        ]
        manifest_rows = [
            # A resumed --overwrite run can list a hash twice.
            {"Hash": "a" * 64, "Compressed Path": str(webm), "Format": "opus", "Bitrate (kbps)": "40"},
            {"Hash": "a" * 64, "Compressed Path": str(webm), "Format": "opus", "Bitrate (kbps)": "40"},
            # Blank Format but an .m4a archive: never replaced by a copy.
            {"Hash": "b" * 64, "Compressed Path": str(m4a_archive), "Format": ""},
        ]

        jobs, skipped = archive_module._select_backfill_jobs(ArchiveRequest(), rows, manifest_rows)

        assert [(row.sha256, path) for row, path in jobs] == [("a" * 64, webm)]
        assert skipped == []

    def test_manifest_writes_keep_symlinks_and_permissions(self, tmp_path):
        target = tmp_path / "real_archived.csv"
        _write_rows(target, OLD_HEADER, [{"Hash": "a"}])
        target.chmod(0o664)
        link = tmp_path / "archived.csv"
        link.symlink_to(target)

        update_manifest_rows(link, {"a": {"Compressed AAC Path": "/out/a.m4a"}})

        assert link.is_symlink()
        assert _read_rows(target)[1][0]["Compressed AAC Path"] == "/out/a.m4a"
        assert oct(target.stat().st_mode & 0o777) == oct(0o664)

    @pytest.mark.integration
    def test_records_each_copy_as_it_finishes(self, tmp_path, require_ffmpeg, monkeypatch):
        """An interrupted run must keep the copies it already made."""
        webms = []
        for name in ("a", "b"):
            webm = tmp_path / f"{name}.webm"
            webm.write_bytes(b"x")
            webms.append(webm)
        rows = [CsvAudioRow(sha256=n * 64, full_path=str(tmp_path / f"{n}.mp3")) for n in "ab"]
        manifest = self._manifest(
            tmp_path,
            [{"Hash": n * 64, "Compressed Path": str(w), "Format": "opus"} for n, w in zip("ab", webms)],
        )
        monkeypatch.setattr(
            archive_module,
            "backfill_aac_copy",
            lambda row, path, **kwargs: archive_module.AacBackfillResult(
                row.sha256, {"Compressed AAC Path": str(path.with_suffix(".m4a"))}, None
            ),
        )
        writes: list[set[str]] = []
        original = archive_module.update_manifest_rows

        def recording(path, updates):  # type: ignore[no-untyped-def]
            writes.append(set(updates))
            return original(path, updates)

        monkeypatch.setattr(archive_module, "update_manifest_rows", recording)

        assert archive_module.run_aac_backfill(ArchiveRequest(parallel=1), rows, manifest) == 0
        assert writes == [{"a" * 64}, {"b" * 64}] or writes == [{"b" * 64}, {"a" * 64}]
        assert {r["Compressed AAC Path"] for r in _read_rows(manifest)[1]} == {
            str(w.with_suffix(".m4a")) for w in webms
        }

    def _fake_copy(self, calls=None, delay=0.0, fail=()):
        import time

        def fake(row, path, **kwargs):
            if calls is not None:
                calls.append(row.sha256)
            time.sleep(delay)
            if row.sha256 in fail:
                raise RuntimeError("encoder vanished")
            return archive_module.AacBackfillResult(
                row.sha256, {"Compressed AAC Path": str(path.with_suffix(".m4a"))}, None
            )

        return fake

    def _jobs(self, tmp_path: Path, hashes: list[str]) -> tuple[Path, list[CsvAudioRow]]:
        manifest_rows = []
        for h in hashes:
            webm = tmp_path / f"{h[0]}.webm"
            webm.write_bytes(b"x")
            manifest_rows.append({"Hash": h, "Compressed Path": str(webm), "Format": "opus"})
        rows = [CsvAudioRow(sha256=h, full_path=str(tmp_path / f"{h[0]}.mp3")) for h in hashes]
        return self._manifest(tmp_path, manifest_rows), rows

    @pytest.mark.integration
    def test_waits_for_the_manifest_lock(self, tmp_path, require_ffmpeg, monkeypatch):
        """The archive writer holds this lock while it appends a row."""
        import fcntl
        import threading
        import time

        manifest, rows = self._jobs(tmp_path, ["a" * 64])
        monkeypatch.setattr(archive_module, "backfill_aac_copy", self._fake_copy())
        lock_path = tmp_path / f".{manifest.name}.lock"

        with lock_path.open("a+") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            worker = threading.Thread(
                target=archive_module.run_aac_backfill, args=(ArchiveRequest(), rows, manifest)
            )
            worker.start()
            time.sleep(0.5)
            assert worker.is_alive()
            assert _read_rows(manifest)[1][0].get("Compressed AAC Path", "") == ""
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        worker.join(timeout=10)

        assert not worker.is_alive()
        assert _read_rows(manifest)[1][0]["Compressed AAC Path"] == str(tmp_path / "a.m4a")

    def test_an_open_writer_appends_to_the_rewritten_manifest(self, tmp_path):
        """A running archive keeps its rows when a backfill replaces the file."""
        manifest = self._manifest(tmp_path, [{"Hash": "a" * 64, "Format": "opus"}])
        writer = ArchivedManifestWriter(manifest, append=True)

        update_manifest_rows(manifest, {"a" * 64: {"Compressed AAC Path": "/out/a.m4a"}})
        writer.write_entry(
            CompressedEntry(
                sha256="b" * 64,
                source=Path("/src/b.mp3"),
                compressed=Path("/out/b.webm"),
                format="opus",
                bitrate_kbps=32,
                source_size_bytes=10,
                compressed_size_bytes=5,
                compression_ratio=2.0,
                duration_seconds=1,
            )
        )
        writer.close()

        written = _read_rows(manifest)[1]
        assert [row["Hash"] for row in written] == ["a" * 64, "b" * 64]
        assert written[0]["Compressed AAC Path"] == "/out/a.m4a"

    @pytest.mark.integration
    def test_a_failing_copy_is_skipped_and_the_rest_continue(
        self, tmp_path, require_ffmpeg, monkeypatch, capsys
    ):
        manifest, rows = self._jobs(tmp_path, ["a" * 64, "b" * 64])
        monkeypatch.setattr(
            archive_module, "backfill_aac_copy", self._fake_copy(fail={"a" * 64})
        )

        archive_module.run_aac_backfill(ArchiveRequest(), rows, manifest)

        by_hash = {row["Hash"]: row for row in _read_rows(manifest)[1]}
        assert by_hash["a" * 64].get("Compressed AAC Path", "") == ""
        assert by_hash["b" * 64]["Compressed AAC Path"] == str(tmp_path / "b.m4a")
        assert "exception: encoder vanished" in capsys.readouterr().out

    @pytest.mark.integration
    def test_interrupt_keeps_recorded_copies_and_starts_no_queued_ones(
        self, tmp_path, require_ffmpeg, monkeypatch, capsys
    ):
        manifest, rows = self._jobs(tmp_path, ["a" * 64, "b" * 64, "c" * 64])
        calls: list[str] = []
        monkeypatch.setattr(
            archive_module, "backfill_aac_copy", self._fake_copy(calls, delay=0.3)
        )
        real_update = archive_module.update_manifest_rows
        interrupted = []

        def update_then_interrupt(path, updates):
            changed = real_update(path, updates)
            if not interrupted:
                interrupted.append(True)
                raise KeyboardInterrupt
            return changed

        monkeypatch.setattr(archive_module, "update_manifest_rows", update_then_interrupt)

        with pytest.raises(KeyboardInterrupt):
            archive_module.run_aac_backfill(ArchiveRequest(parallel=1), rows, manifest)

        # The first copy was recorded; the one being encoded (whose ffmpeg a
        # real Ctrl-C stops too) is not waited for; the third never started.
        assert calls[0] == "a" * 64
        assert "c" * 64 not in calls
        by_hash = {row["Hash"]: row for row in _read_rows(manifest)[1]}
        assert by_hash["a" * 64]["Compressed AAC Path"] == str(tmp_path / "a.m4a")
        assert by_hash["b" * 64].get("Compressed AAC Path", "") == ""
        assert by_hash["c" * 64].get("Compressed AAC Path", "") == ""
        assert "Run --backfill-aac again" in capsys.readouterr().out

    @pytest.mark.integration
    def test_waits_for_the_catalog_ingest_lock(self, tmp_path, require_ffmpeg, monkeypatch):
        """An ingest worker on an older release appends under this lock only."""
        import fcntl
        import threading
        import time

        manifest, rows = self._jobs(tmp_path, ["a" * 64])
        monkeypatch.setattr(archive_module, "backfill_aac_copy", self._fake_copy())

        with (tmp_path / ".ingest-20260101_000000.lock").open("a+") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            worker = threading.Thread(
                target=archive_module.run_aac_backfill, args=(ArchiveRequest(), rows, manifest)
            )
            worker.start()
            time.sleep(0.5)
            assert worker.is_alive()
            assert _read_rows(manifest)[1][0].get("Compressed AAC Path", "") == ""
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        worker.join(timeout=10)

        assert not worker.is_alive()
        assert _read_rows(manifest)[1][0]["Compressed AAC Path"] == str(tmp_path / "a.m4a")

    @pytest.mark.integration
    def test_a_copy_whose_row_was_removed_is_deleted(
        self, tmp_path, require_ffmpeg, monkeypatch, capsys
    ):
        manifest, rows = self._jobs(tmp_path, ["a" * 64])

        def copy_while_removed(row, path, **kwargs):
            copy = path.with_suffix(".m4a")
            copy.write_bytes(b"aac")
            # `catalog remove` drops the row while the copy is encoding.
            _write_rows(manifest, OLD_HEADER, [])
            return archive_module.AacBackfillResult(
                row.sha256, {"Compressed AAC Path": str(copy)}, None
            )

        monkeypatch.setattr(archive_module, "backfill_aac_copy", copy_while_removed)

        archive_module.run_aac_backfill(ArchiveRequest(), rows, manifest)

        assert not (tmp_path / "a.m4a").exists()
        out = capsys.readouterr().out
        assert "no longer in the manifest" in out
        assert "AAC copies added: 0" in out
