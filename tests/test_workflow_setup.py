"""Tests for shared workflow command setup (catalog resolution guards)."""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from besedy.commands.catalog import workflow_setup


def _write_catalog_csv(path: Path) -> Path:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["Hash", "Filename", "Full Path", "Status"])
        writer.writeheader()
        writer.writerow(
            {
                "Hash": "a" * 64,
                "Filename": "audio.wav",
                "Full Path": str(path.parent / "audio.wav"),
                "Status": "EXISTS",
            }
        )
    return path


class TestRejectStaleAsrManifests:
    """Manifests from the removed enhanced/ASR pipeline must not be silently skipped."""

    def test_errors_when_stale_asr_symlink_exists(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        (tmp_path / "audio_catalog_asr.csv").touch()
        monkeypatch.setattr(workflow_setup, "resolve_catalogs_root", lambda: tmp_path)

        with pytest.raises(SystemExit):
            workflow_setup.resolve_and_load_catalog(None, "transcribe", limit=None)

        err = capsys.readouterr().err
        assert "removed enhanced pipeline" in err
        assert "audio_catalog_asr.csv" in err

    def test_errors_when_stale_variant_manifest_exists(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        (tmp_path / "audio_catalog_asr_dfn.csv").touch()
        monkeypatch.setattr(workflow_setup, "resolve_catalogs_root", lambda: tmp_path)

        with pytest.raises(SystemExit):
            workflow_setup.resolve_and_load_catalog(None, "diarize", limit=None)

        assert "audio_catalog_asr_dfn.csv" in capsys.readouterr().err

    def test_explicit_csv_bypasses_the_guard(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        (tmp_path / "audio_catalog_asr.csv").touch()
        monkeypatch.setattr(workflow_setup, "resolve_catalogs_root", lambda: tmp_path)
        monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))
        catalog = _write_catalog_csv(tmp_path / "audio_catalog_20260101_120000_normalized.csv")

        result = workflow_setup.resolve_and_load_catalog(catalog, "transcribe", limit=None)

        assert result is not None
        csv_path, rows = result
        assert csv_path == catalog
        assert len(rows) == 1

    def test_no_stale_manifests_is_quiet(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(workflow_setup, "resolve_catalogs_root", lambda: tmp_path)

        workflow_setup._reject_stale_asr_manifests("transcribe")


class TestExtractRunInfo:
    def test_normalized_catalog_yields_timestamp(self, tmp_path: Path) -> None:
        catalog = tmp_path / "audio_catalog_20260101_120000_normalized.csv"
        catalog.touch()

        run_id, base_name = workflow_setup.extract_run_info(catalog)

        assert run_id == "20260101_120000"
        assert base_name == "transcripts"

    def test_asr_manifest_is_rejected_with_pointer_to_removal(
        self,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        catalog = tmp_path / "audio_catalog_20260101_120000_asr_dfn.csv"
        catalog.touch()

        with pytest.raises(SystemExit):
            workflow_setup.extract_run_info(catalog)

        assert "no longer supported" in capsys.readouterr().err
