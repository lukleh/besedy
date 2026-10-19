"""Tests for subprocess_utils module."""

from __future__ import annotations

import sys

import pytest

from besedy.lib.subprocess_utils import (
    _HAS_TERMIOS,
    check_binary,
    install_signal_handlers,
    reset_terminal,
    safe_decode,
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


class TestSignalHandlers:
    """Tests for signal handler installation."""

    def test_install_signal_handlers_idempotent(self):
        # Should not raise when called multiple times
        install_signal_handlers()
        install_signal_handlers()
        install_signal_handlers()


class TestTerminalState:
    """Tests for terminal state utility functions."""

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
