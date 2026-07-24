"""Real subprocess integration tests (no mocks).

These tests actually execute subprocess commands to verify:
1. WorkflowRunner can launch and manage real processes
2. Subprocess timeouts and error handling work correctly
3. Environment variables are passed correctly

Marked with @pytest.mark.integration - requires no special dependencies.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from besedy.lib.workflow.common import WorkflowCommand
from besedy.lib.workflow.runner import launch_workflows

# Project root for finding the checked-in example config.
PROJECT_ROOT = Path(__file__).parent.parent


@pytest.fixture
def besedy_env(tmp_path: Path):
    """Return environment with BESEDY_CONFIG set to the checked-in example config."""
    env = os.environ.copy()
    env["BESEDY_CONFIG"] = str(PROJECT_ROOT / "besedy.toml.example")
    env["BESEDY_TEXT_DATA_ROOT"] = str(tmp_path / "text-data")
    return env


@pytest.mark.integration
class TestRealSubprocessExecution:
    """Tests that actually run subprocess commands."""

    def test_launch_echo_command_succeeds(self):
        """Real echo command executes and returns success."""
        spec = WorkflowCommand(label="echo-test", argv=["echo", "hello"])
        failures = launch_workflows([spec], base_env=os.environ.copy())
        assert failures == [], "echo command should succeed"

    def test_launch_python_command_succeeds(self):
        """Real Python command executes and returns success."""
        spec = WorkflowCommand(
            label="python-test",
            argv=[sys.executable, "-c", "print('hello from python')"],
        )
        failures = launch_workflows([spec], base_env=os.environ.copy())
        assert failures == [], "python -c command should succeed"

    def test_launch_failing_command_reports_failure(self):
        """Command that exits with non-zero is reported as failure."""
        spec = WorkflowCommand(
            label="fail-test",
            argv=[sys.executable, "-c", "import sys; sys.exit(42)"],
        )
        failures = launch_workflows([spec], base_env=os.environ.copy())
        assert len(failures) == 1
        assert failures[0][0] == "fail-test"
        assert failures[0][1] == 42

    def test_launch_nonexistent_command_reports_failure(self):
        """Nonexistent command is reported as failure."""
        spec = WorkflowCommand(
            label="missing-cmd",
            argv=["__nonexistent_command_12345__", "arg"],
        )
        failures = launch_workflows([spec], base_env=os.environ.copy())
        assert len(failures) == 1
        assert failures[0][0] == "missing-cmd"

    def test_parallel_group_executes_concurrently(self):
        """Parallel group actually runs commands concurrently."""
        # Each command sleeps for 0.3s. If sequential, total > 0.6s.
        # If parallel, total should be ~0.3s.
        specs = [
            WorkflowCommand(
                label="sleep-a",
                argv=[sys.executable, "-c", "import time; time.sleep(0.3)"],
                parallel_group="sleepers",
            ),
            WorkflowCommand(
                label="sleep-b",
                argv=[sys.executable, "-c", "import time; time.sleep(0.3)"],
                parallel_group="sleepers",
            ),
        ]
        start = time.time()
        failures = launch_workflows(specs, base_env=os.environ.copy())
        elapsed = time.time() - start

        assert failures == [], "Both sleep commands should succeed"
        # Allow some overhead, but should be < 0.6s (sequential would be > 0.6s)
        assert elapsed < 0.55, f"Parallel execution took too long: {elapsed:.2f}s"

    def test_environment_variables_passed_to_subprocess(self):
        """Environment variables are passed to subprocess."""
        # Create a file with the env var value
        spec = WorkflowCommand(
            label="env-test",
            argv=[
                sys.executable,
                "-c",
                "import os; assert os.environ.get('TEST_VAR') == 'test_value'",
            ],
        )
        env = os.environ.copy()
        env["TEST_VAR"] = "test_value"
        failures = launch_workflows([spec], base_env=env)
        assert failures == [], "Environment variable should be passed"

    def test_workflow_with_extra_env(self):
        """Extra environment variables are merged correctly."""
        spec = WorkflowCommand(
            label="extra-env-test",
            argv=[
                sys.executable,
                "-c",
                "import os; assert os.environ.get('EXTRA_VAR') == 'extra_value'",
            ],
            extra_env={"EXTRA_VAR": "extra_value"},
        )
        failures = launch_workflows([spec], base_env=os.environ.copy())
        assert failures == [], "Extra env should be merged"


@pytest.mark.integration
class TestRealFfprobeExecution:
    """Tests that actually run ffprobe on real audio files."""

    def test_ffprobe_available(self):
        """ffprobe is available in PATH."""
        result = subprocess.run(
            ["ffprobe", "-version"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, "ffprobe should be installed"

    def test_ffprobe_on_synthetic_wav(self, wav_16k_mono):
        """ffprobe can analyze a synthetic WAV file."""
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=sample_rate,channels",
                "-of",
                "csv=p=0",
                str(wav_16k_mono),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"ffprobe failed: {result.stderr}"
        # Should output "16000,1" for 16kHz mono
        output = result.stdout.strip()
        assert "16000" in output, f"Sample rate not 16000: {output}"
        assert "1" in output, f"Not mono: {output}"

    def test_ffprobe_duration_extraction(self, wav_16k_mono):
        """ffprobe extracts correct duration from WAV file."""
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(wav_16k_mono),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        duration = float(result.stdout.strip())
        # wav_16k_mono fixture creates 1-second file
        assert 0.9 < duration < 1.1, f"Duration not ~1s: {duration}"


@pytest.mark.integration
class TestRealFfmpegExecution:
    """Tests that actually run ffmpeg on real audio files."""

    def test_ffmpeg_available(self):
        """ffmpeg is available in PATH."""
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, "ffmpeg should be installed"

    def test_ffmpeg_convert_sample_rate(self, wav_16k_mono, tmp_path):
        """ffmpeg can convert sample rate."""
        output = tmp_path / "converted.wav"
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(wav_16k_mono),
                "-ar",
                "8000",
                "-ac",
                "1",
                str(output),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"ffmpeg failed: {result.stderr}"
        assert output.exists()

        # Verify the conversion
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=sample_rate",
                "-of",
                "csv=p=0",
                str(output),
            ],
            capture_output=True,
            text=True,
        )
        assert probe.stdout.strip() == "8000"

    def test_ffmpeg_loudness_analysis(self, wav_16k_mono):
        """ffmpeg loudnorm filter can analyze audio."""
        result = subprocess.run(
            [
                "ffmpeg",
                "-i",
                str(wav_16k_mono),
                "-af",
                "loudnorm=print_format=json",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
        )
        # loudnorm outputs to stderr
        assert result.returncode == 0, f"ffmpeg failed: {result.stderr}"
        # Should contain LUFS measurement
        assert "input_i" in result.stderr.lower() or "lufs" in result.stderr.lower()


@pytest.mark.integration
class TestRealCatalogCLI:
    """Tests that actually run catalog CLI commands."""

    def test_catalog_help(self, besedy_env):
        """catalog.py --help works."""
        result = subprocess.run(
            [sys.executable, "-m", "besedy.cli.catalog", "--help"],
            capture_output=True,
            text=True,
            env=besedy_env,
        )
        assert result.returncode == 0
        assert "create" in result.stdout.lower()
        assert "stage" in result.stdout.lower()

    def test_catalog_create_on_directory(self, tmp_path, besedy_env):
        """catalog create actually scans a directory."""
        # Create some audio files
        audio_dir = tmp_path / "audio"
        audio_dir.mkdir()

        # Create synthetic WAV files using wave module
        import wave

        for name in ["test1.wav", "test2.wav"]:
            wav_path = audio_dir / name
            with wave.open(str(wav_path), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(16000)
                # Write different content for different hashes
                wf.writeframes(
                    bytes([i % 256 for i in range(32000)])
                    if name == "test1.wav"
                    else bytes([255 - i % 256 for i in range(32000)])
                )

        # Run catalog create
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "besedy.cli.catalog",
                "create",
                str(audio_dir),
                "--output",
                str(tmp_path / "catalog.csv"),
            ],
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
            env=besedy_env,
        )

        if result.returncode != 0:
            print(f"STDOUT: {result.stdout}")
            print(f"STDERR: {result.stderr}")

        assert result.returncode == 0, f"catalog create failed: {result.stderr}"

        # Verify output
        catalog_csv = tmp_path / "catalog.csv"
        assert catalog_csv.exists(), "Catalog CSV should be created"

        content = catalog_csv.read_text()
        lines = content.strip().split("\n")

        # Should have header + at least 1 data row
        assert len(lines) >= 2, f"Expected at least header + 1 row, got {len(lines)}"
        assert "Hash" in content or "hash" in content.lower()
        # At least one test file should be found
        assert ".wav" in content


@pytest.mark.integration
class TestRealAnalyzeCLI:
    """Tests that actually run analyze CLI commands."""

    def test_analyze_help(self, besedy_env):
        """analyze.py --help works."""
        result = subprocess.run(
            [sys.executable, "-m", "besedy.cli.analyze", "--help"],
            capture_output=True,
            text=True,
            env=besedy_env,
        )
        assert result.returncode == 0
        assert "validate" in result.stdout.lower()

    def test_catalog_validate_help(self, besedy_env):
        """catalog.py validate --help works."""
        result = subprocess.run(
            [sys.executable, "-m", "besedy.cli.catalog", "validate", "--help"],
            capture_output=True,
            text=True,
            env=besedy_env,
        )
        assert result.returncode == 0
        assert "input-path" in result.stdout.lower()


@pytest.mark.integration
class TestRealHashComputation:
    """Tests that actually compute SHA256 hashes on real files."""

    def test_sha256_on_real_file(self, tmp_path):
        """Source checksum produces the expected hash for known content."""
        from besedy.lib.catalog.manager import source_file_sha256

        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")

        # Known SHA256 for "Hello, World!"
        expected = "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"

        result = source_file_sha256(test_file)
        assert result == expected

    def test_sha256_deterministic(self, wav_16k_mono):
        """Source checksum is deterministic for the same file content."""
        from besedy.lib.catalog.manager import source_file_sha256

        hash1 = source_file_sha256(wav_16k_mono)
        hash2 = source_file_sha256(wav_16k_mono)

        assert hash1 == hash2
        assert len(hash1) == 64
        assert all(c in "0123456789abcdef" for c in hash1)

    def test_sha256_different_for_different_content(self, tmp_path):
        """Source checksum changes for different file content."""
        from besedy.lib.catalog.manager import source_file_sha256

        file1 = tmp_path / "file1.txt"
        file2 = tmp_path / "file2.txt"
        file1.write_text("content1")
        file2.write_text("content2")

        hash1 = source_file_sha256(file1)
        hash2 = source_file_sha256(file2)

        assert hash1 != hash2
