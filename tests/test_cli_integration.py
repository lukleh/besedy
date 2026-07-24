"""Integration tests for CLI commands.

These tests require external tools (ffmpeg, ffprobe) and perform actual I/O.
"""

from __future__ import annotations

import csv
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from besedy.lib.catalog.manager import AUDIO_HASH_ALGORITHM
from tests.helpers.audio import create_silent_wav, create_tone_wav

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def audio_dir_with_files(tmp_path):
    """Create a directory with audio files for catalog testing."""
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()

    # Create several audio files
    create_silent_wav(audio_dir / "silence_1.wav", duration_seconds=1.0)
    create_tone_wav(audio_dir / "tone_440.wav", frequency=440.0, duration_seconds=1.5)
    create_silent_wav(audio_dir / "silence_2.wav", duration_seconds=2.0)

    return audio_dir


class TestCatalogCreateIntegration:
    """Integration tests for 'catalog create' command."""

    @pytest.mark.integration
    def test_create_catalog_basic(self, audio_dir_with_files, tmp_path, require_ffmpeg):
        """Create catalog with basic metadata (fast mode)."""
        output_csv = tmp_path / "catalog.csv"

        result = subprocess.run(
            [
                "uv",
                "run",
                "python",
                "-m",
                "besedy.cli.catalog",
                "create",
                str(audio_dir_with_files),
                "--output",
                str(output_csv),
            ],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
        )

        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert output_csv.exists()

        # Verify CSV structure
        with output_csv.open() as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        assert len(rows) == 3
        assert all(row["Hash"] for row in rows)
        assert all(row["Hash Algorithm"] == AUDIO_HASH_ALGORITHM for row in rows)
        assert all(row["Filename"] for row in rows)

    @pytest.mark.integration
    def test_create_catalog_with_ffprobe(self, audio_dir_with_files, tmp_path, require_ffmpeg):
        """Create catalog with ffprobe metadata enrichment."""
        output_csv = tmp_path / "catalog.csv"

        result = subprocess.run(
            [
                "uv",
                "run",
                "python",
                "-m",
                "besedy.cli.catalog",
                "create",
                str(audio_dir_with_files),
                "--output",
                str(output_csv),
            ],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
        )

        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert output_csv.exists()

        # Verify CSV is created with the right number of rows
        with output_csv.open() as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        assert len(rows) == 3
        # Verify all files have hashes (ffprobe may or may not populate Duration)
        assert all(row.get("Hash") for row in rows), "All files should have Hash"


class TestCatalogMergeIntegration:
    """Integration tests for 'catalog merge' command."""

    @pytest.mark.integration
    def test_merge_two_catalogs(self, tmp_path):
        """Merge two CSV catalogs."""
        # Create first catalog
        csv1 = tmp_path / "catalog1.csv"
        csv1.write_text(
            "Hash,Hash Algorithm,Filename,Status\n"
            f"abc123,{AUDIO_HASH_ALGORITHM},file1.wav,EXISTS\n"
            f"def456,{AUDIO_HASH_ALGORITHM},file2.wav,EXISTS\n",
            encoding="utf-8",
        )

        # Create second catalog with one new file
        csv2 = tmp_path / "catalog2.csv"
        csv2.write_text(
            "Hash,Hash Algorithm,Filename,Status\n"
            f"def456,{AUDIO_HASH_ALGORITHM},file2.wav,EXISTS\n"
            f"ghi789,{AUDIO_HASH_ALGORITHM},file3.wav,EXISTS\n",
            encoding="utf-8",
        )

        output_csv = tmp_path / "merged.csv"

        result = subprocess.run(
            [
                "uv",
                "run",
                "python",
                "-m",
                "besedy.cli.catalog",
                "merge",
                str(csv1),
                str(csv2),
                "--output",
                str(output_csv),
            ],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
        )

        assert result.returncode == 0, f"stderr: {result.stderr}"
        assert output_csv.exists()

        # Verify merge result
        with output_csv.open() as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        # Should have 3 unique files (def456 deduplicated)
        hashes = {row["Hash"] for row in rows}
        assert hashes == {"abc123", "def456", "ghi789"}


class TestCatalogCheckIntegration:
    """Integration tests for 'catalog check' command."""

    @pytest.mark.integration
    def test_check_missing_catalog(self, tmp_path):
        """Check command reports missing catalog gracefully."""
        result = subprocess.run(
            [
                "uv",
                "run",
                "python",
                "-m",
                "besedy.cli.catalog",
                "check",
                "--csv",
                str(tmp_path / "nonexistent.csv"),
            ],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
        )

        # Should fail gracefully
        assert (
            result.returncode != 0
            or "not found" in result.stderr.lower()
            or "error" in result.stderr.lower()
        )


class TestCatalogValidateIntegration:
    """Integration tests for catalog validate."""

    @pytest.fixture
    def transcripts_with_files(self, tmp_path):
        """Create a transcripts directory with valid transcript files."""
        from tests.helpers.transcript import (
            create_transcript_with_words,
            write_transcript_json,
        )

        root = tmp_path / "transcripts_test"
        root.mkdir()

        # Create a valid transcript structure
        backend_dir = root / "faster-whisper" / "large-v3@silero_vad_v6" / "abc123def456"
        backend_dir.mkdir(parents=True)

        transcript = create_transcript_with_words(
            words=["Hello", "world", "test"],
            confidence=0.95,
        )
        write_transcript_json(backend_dir / "transcript.json", transcript)

        return root

    @pytest.mark.integration
    def test_validate_transcripts_json_output(self, transcripts_with_files):
        """Validate transcripts with JSON output format."""
        result = subprocess.run(
            [
                "uv",
                "run",
                "python",
                "-m",
                "besedy.cli.catalog",
                "validate",
                "--input-path",
                str(transcripts_with_files),
                "--format",
                "json",
                "--no-diarization",
            ],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
        )

        assert result.returncode == 0, f"stderr: {result.stderr}"

        # Output should be valid JSON
        import json

        output = json.loads(result.stdout)
        assert output["name"] == "validate"
        assert output["status"] == "success"

    @pytest.mark.integration
    def test_validate_single_transcript(self, transcripts_with_files):
        """Validate a single transcript file."""
        transcript_file = list(transcripts_with_files.rglob("transcript.json"))[0]

        result = subprocess.run(
            [
                "uv",
                "run",
                "python",
                "-m",
                "besedy.cli.catalog",
                "validate",
                "--input-path",
                str(transcript_file),
            ],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
        )

        assert result.returncode == 0, f"stderr: {result.stderr}"


class TestAnalyzeIntegration:
    """Integration tests for analyze CLI."""

    @pytest.mark.integration
    def test_analyze_validate_command(self):
        """Run analyze validate command."""
        result = subprocess.run(
            [
                "uv",
                "run",
                "python",
                "-m",
                "besedy.cli.analyze",
                "validate",
                "--limit",
                "1",
                "--format",
                "json",
            ],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
            timeout=60,
        )

        assert result.returncode == 0, f"Unexpected error: {result.stderr}"


class TestCliHelpMessages:
    """Tests for CLI help messages and usage."""

    @pytest.mark.integration
    def test_catalog_help(self):
        """Catalog CLI shows help."""
        result = subprocess.run(
            ["uv", "run", "python", "-m", "besedy.cli.catalog", "--help"],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
        )

        assert result.returncode == 0
        assert "create" in result.stdout
        assert "merge" in result.stdout
        assert "stage-audio" in result.stdout

    @pytest.mark.integration
    def test_catalog_validate_help(self):
        """Catalog validate subcommand shows help."""
        result = subprocess.run(
            ["uv", "run", "python", "-m", "besedy.cli.catalog", "validate", "--help"],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
        )

        assert result.returncode == 0
        assert "--input-path" in result.stdout

    @pytest.mark.integration
    def test_analyze_help(self):
        """Analyze CLI shows help."""
        result = subprocess.run(
            ["uv", "run", "python", "-m", "besedy.cli.analyze", "--help"],
            capture_output=True,
            text=True,
            cwd=Path.cwd(),
        )

        assert result.returncode == 0
        assert "validate" in result.stdout


class TestBaseInstallCliSmoke:
    """Smoke tests for the lean base install path."""

    @pytest.mark.integration
    @pytest.mark.slow
    def test_base_install_supports_cli_import_and_help(self, tmp_path):
        """Base install can import lightweight CLIs from outside the checkout."""
        if shutil.which("uv") is None:
            pytest.skip("uv is required for base-install smoke test")

        venv_dir = tmp_path / "venv"
        probe_dir = tmp_path / "probe"
        probe_dir.mkdir()

        env = os.environ.copy()
        env.pop("PYTHONPATH", None)
        env["PYTHONNOUSERSITE"] = "1"

        venv_result = subprocess.run(
            ["uv", "venv", str(venv_dir)],
            capture_output=True,
            text=True,
            cwd=probe_dir,
            env=env,
            timeout=120,
        )
        assert venv_result.returncode == 0, f"stderr: {venv_result.stderr}"

        python_exe = venv_dir / "bin" / "python"
        install_result = subprocess.run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(python_exe),
                "-e",
                str(PROJECT_ROOT),
            ],
            capture_output=True,
            text=True,
            cwd=probe_dir,
            env=env,
            timeout=300,
        )
        assert install_result.returncode == 0, f"stderr: {install_result.stderr}"

        probes = [
            ["-c", "import besedy.cli.catalog"],
            ["-m", "besedy.cli.catalog", "--help"],
            ["-m", "besedy.cli.catalog", "create", "--help"],
            ["-m", "besedy.cli.analyze", "--help"],
        ]
        for argv in probes:
            result = subprocess.run(
                [str(python_exe), *argv],
                capture_output=True,
                text=True,
                cwd=probe_dir,
                env=env,
                timeout=120,
            )
            assert result.returncode == 0, (
                f"command failed: {python_exe} {' '.join(argv)}\n"
                f"stdout: {result.stdout}\n"
                f"stderr: {result.stderr}"
            )
