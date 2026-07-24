"""Tests for subprocess_utils module."""

from __future__ import annotations

import subprocess
import sys

import pytest

from besedy.lib.subprocess_utils import (
    _HAS_TERMIOS,
    SubprocessResult,
    check_binary,
    install_signal_handlers,
    reset_terminal,
    restore_terminal_state,
    run_batch,
    run_parallel,
    safe_decode,
    save_terminal_state,
    stream_lines,
)


class TestSafeDecode:
    """Tests for safe_decode function."""

    def test_decode_valid_utf8(self):
        assert safe_decode(b"hello world") == "hello world"

    def test_decode_none(self):
        assert safe_decode(None) == ""

    def test_decode_empty(self):
        assert safe_decode(b"") == ""

    def test_decode_invalid_utf8_replaces(self):
        # Invalid UTF-8 byte sequence
        result = safe_decode(b"hello \xff\xfe world")
        assert "hello" in result
        assert "world" in result
        assert "\ufffd" in result  # Replacement character

    def test_decode_with_strict_raises(self):
        with pytest.raises(UnicodeDecodeError):
            safe_decode(b"\xff\xfe", errors="strict")


class TestSubprocessResult:
    """Tests for SubprocessResult dataclass."""

    def test_success_property_zero(self):
        result = SubprocessResult(label="test", returncode=0)
        assert result.success is True

    def test_success_property_nonzero(self):
        result = SubprocessResult(label="test", returncode=1)
        assert result.success is False

    def test_success_property_negative(self):
        result = SubprocessResult(label="test", returncode=-1)
        assert result.success is False

    def test_defaults(self):
        result = SubprocessResult(label="test", returncode=0)
        assert result.stdout == ""
        assert result.stderr == ""


class TestCheckBinary:
    """Tests for check_binary function."""

    def test_existing_binary(self):
        # Python should always exist
        assert check_binary(sys.executable, "--version") is True

    def test_nonexistent_binary(self):
        assert check_binary("nonexistent_binary_12345") is False

    def test_binary_with_bad_flag(self):
        # Even with a bad flag, the binary exists but may fail
        # This tests CalledProcessError handling
        result = check_binary(sys.executable, "--invalid-flag-xyz")
        # Python exits with error on invalid flag, so this should be False
        assert result is False


class TestRunBatch:
    """Tests for run_batch function."""

    def test_all_succeed(self):
        commands = [
            ("echo1", [sys.executable, "-c", "print('hello')"]),
            ("echo2", [sys.executable, "-c", "print('world')"]),
        ]
        successes, failures = run_batch(commands)

        assert len(successes) == 2
        assert len(failures) == 0
        assert successes[0].label == "echo1"
        assert "hello" in successes[0].stdout
        assert successes[1].label == "echo2"
        assert "world" in successes[1].stdout

    def test_continues_after_failure(self):
        commands = [
            ("pass1", [sys.executable, "-c", "print('first')"]),
            ("fail", [sys.executable, "-c", "import sys; sys.exit(1)"]),
            ("pass2", [sys.executable, "-c", "print('third')"]),
        ]
        successes, failures = run_batch(commands)

        # Should have run all three, even though middle one failed
        assert len(successes) == 2
        assert len(failures) == 1
        assert failures[0].label == "fail"
        assert successes[0].label == "pass1"
        assert successes[1].label == "pass2"

    def test_captures_stderr(self):
        commands = [
            ("stderr", [sys.executable, "-c", "import sys; print('error', file=sys.stderr)"]),
        ]
        successes, failures = run_batch(commands)

        assert len(successes) == 1
        assert "error" in successes[0].stderr

    def test_handles_nonexistent_command(self):
        commands = [
            ("bad", ["nonexistent_command_12345"]),
            ("good", [sys.executable, "-c", "print('ok')"]),
        ]
        successes, failures = run_batch(commands)

        assert len(failures) == 1
        assert len(successes) == 1
        assert failures[0].returncode == -1
        assert (
            "nonexistent" in failures[0].stderr.lower() or "not found" in failures[0].stderr.lower()
        )

    def test_on_start_callback(self):
        started = []
        commands = [
            ("task1", [sys.executable, "-c", "pass"]),
            ("task2", [sys.executable, "-c", "pass"]),
        ]
        run_batch(commands, on_start=lambda label: started.append(label))

        assert started == ["task1", "task2"]

    def test_on_complete_callback(self):
        completed = []
        commands = [
            ("task1", [sys.executable, "-c", "pass"]),
            ("task2", [sys.executable, "-c", "import sys; sys.exit(1)"]),
        ]
        run_batch(commands, on_complete=lambda res: completed.append((res.label, res.success)))

        assert completed == [("task1", True), ("task2", False)]

    def test_timeout(self):
        commands = [
            ("slow", [sys.executable, "-c", "import time; time.sleep(10)"]),
        ]
        successes, failures = run_batch(commands, timeout=0.1)

        assert len(failures) == 1
        assert "timed out" in failures[0].stderr.lower()


class TestRunParallel:
    """Tests for run_parallel function."""

    def test_all_succeed(self):
        commands = [
            ("task1", [sys.executable, "-c", "print('a')"]),
            ("task2", [sys.executable, "-c", "print('b')"]),
        ]
        successes, failures = run_parallel(commands, live_output=False)

        assert len(successes) == 2
        assert len(failures) == 0

    def test_continues_after_failure(self):
        commands = [
            ("pass1", [sys.executable, "-c", "print('first')"]),
            ("fail", [sys.executable, "-c", "import sys; sys.exit(1)"]),
            ("pass2", [sys.executable, "-c", "print('third')"]),
        ]
        successes, failures = run_parallel(commands, live_output=False)

        assert len(successes) == 2
        assert len(failures) == 1

    def test_captures_output_when_not_live(self):
        commands = [
            ("output", [sys.executable, "-c", "print('captured')"]),
        ]
        successes, failures = run_parallel(commands, live_output=False)

        assert len(successes) == 1
        assert "captured" in successes[0].stdout

    def test_handles_nonexistent_command(self):
        commands = [
            ("bad", ["nonexistent_command_12345"]),
            ("good", [sys.executable, "-c", "print('ok')"]),
        ]
        successes, failures = run_parallel(commands, live_output=False)

        assert len(failures) == 1
        assert len(successes) == 1

    def test_on_complete_callback(self):
        completed = []
        commands = [
            ("task1", [sys.executable, "-c", "pass"]),
        ]
        run_parallel(
            commands,
            live_output=False,
            on_complete=lambda res: completed.append(res.label),
        )

        assert completed == ["task1"]

    def test_stdio_returned_after_live_output(self):
        """Verify stdin/stdout work correctly after parallel subprocesses with live_output."""
        commands = [
            ("task1", [sys.executable, "-c", "print('live1')"]),
            ("task2", [sys.executable, "-c", "print('live2')"]),
        ]
        run_parallel(commands, live_output=True)

        # If stdio is broken/not returned to shell, this would hang or fail
        result = subprocess.run(
            [sys.executable, "-c", "print('after_parallel')"],
            capture_output=True,
            timeout=5,
        )
        assert result.returncode == 0
        assert b"after_parallel" in result.stdout

    def test_stdio_returned_after_captured_output(self):
        """Verify stdin/stdout work correctly after parallel subprocesses with captured output."""
        commands = [
            ("task1", [sys.executable, "-c", "print('captured1')"]),
            ("task2", [sys.executable, "-c", "print('captured2')"]),
        ]
        run_parallel(commands, live_output=False)

        # Subsequent subprocess should work normally
        result = subprocess.run(
            [sys.executable, "-c", "print('after_captured')"],
            capture_output=True,
            timeout=5,
        )
        assert result.returncode == 0
        assert b"after_captured" in result.stdout


class TestStreamLines:
    """Tests for stream_lines function."""

    def test_streams_lines(self):
        lines = []
        code = "print('line1'); print('line2'); print('line3')"
        exitcode = stream_lines(
            [sys.executable, "-c", code],
            line_handler=lambda line: lines.append(line),
        )

        assert exitcode == 0
        assert lines == ["line1", "line2", "line3"]

    def test_strips_newlines(self):
        lines = []
        code = "print('hello\\n')"  # Extra newline
        stream_lines(
            [sys.executable, "-c", code],
            line_handler=lambda line: lines.append(line),
        )

        # Should only have one entry, newline stripped
        assert len(lines) == 2  # 'hello' and empty string from extra newline
        assert lines[0] == "hello"

    def test_returns_exit_code(self):
        exitcode = stream_lines(
            [sys.executable, "-c", "import sys; print('x'); sys.exit(42)"],
            line_handler=lambda _: None,
        )
        assert exitcode == 42


class TestSignalHandlers:
    """Tests for signal handler installation."""

    def test_install_signal_handlers_idempotent(self):
        # Should not raise when called multiple times
        install_signal_handlers()
        install_signal_handlers()
        install_signal_handlers()


class TestTerminalState:
    """Tests for terminal state utility functions."""

    def test_save_terminal_state_no_tty(self):
        """save_terminal_state returns None when not connected to TTY."""
        # In pytest, stdin is usually not a TTY
        if sys.stdin.isatty():
            pytest.skip("Test requires non-TTY stdin")
        result = save_terminal_state()
        assert result is None

    def test_restore_terminal_state_none_safe(self):
        """restore_terminal_state handles None safely."""
        # Should not raise
        restore_terminal_state(None)

    def test_reset_terminal_no_tty(self):
        """reset_terminal is safe when not connected to TTY."""
        # Should not raise even without TTY
        reset_terminal()

    @pytest.mark.skipif(not _HAS_TERMIOS, reason="termios not available")
    def test_termios_available_on_unix(self):
        """termios should be available on Unix systems."""
        import termios

        assert hasattr(termios, "tcgetattr")
        assert hasattr(termios, "tcsetattr")
        assert hasattr(termios, "ECHO")
        assert hasattr(termios, "ICANON")

    def test_terminal_functions_work_after_parallel(self):
        """Verify terminal functions work after run_parallel completes."""
        commands = [
            ("task1", [sys.executable, "-c", "print('hello')"]),
        ]
        run_parallel(commands, live_output=True)

        # After run_parallel, terminal functions should work
        # (will return None if not TTY, but shouldn't crash)
        result = save_terminal_state()
        assert result is None or isinstance(result, list)

        # reset_terminal should also work
        reset_terminal()
