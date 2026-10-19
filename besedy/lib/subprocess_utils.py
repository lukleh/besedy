"""Shared subprocess registration, signal cleanup, decoding, and binary checks."""

from __future__ import annotations

import atexit
import signal
import subprocess
import sys
import threading

# Terminal state preservation (Unix only)
try:
    import termios

    _HAS_TERMIOS = True
except ImportError:
    _HAS_TERMIOS = False

# Global registry of active processes for signal cleanup
_active_processes: dict[int, subprocess.Popen] = {}
_processes_lock = threading.Lock()
_signal_handlers_installed = False


def reset_terminal() -> None:
    """Reset terminal to sane defaults if termios available.

    This is a fallback when saved state is unavailable. Restores:
    - Echo mode (so you can see what you type)
    - Canonical mode (line buffering)
    """
    if not _HAS_TERMIOS:
        return
    try:
        if sys.stdin.isatty():
            # Get current attrs and enable echo + canonical mode
            attrs = termios.tcgetattr(sys.stdin)
            # attrs[3] is the local flags (lflag)
            attrs[3] |= termios.ECHO | termios.ICANON
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, attrs)
    except (termios.error, OSError):
        pass


def safe_decode(data: bytes | None, errors: str = "replace") -> str:
    """Decode bytes to UTF-8 with error replacement.

    Args:
        data: Bytes to decode, or None
        errors: Error handling strategy (default: "replace")

    Returns:
        Decoded string, or empty string if data is None
    """
    return data.decode("utf-8", errors=errors) if data else ""


def register_process(proc: subprocess.Popen) -> None:
    """Register process for signal cleanup.

    Call this after launching a subprocess.Popen to ensure it gets
    cleaned up on SIGINT/SIGTERM. Call unregister_process after
    the process completes.
    """
    with _processes_lock:
        _active_processes[proc.pid] = proc


def unregister_process(proc: subprocess.Popen) -> None:
    """Unregister process after completion.

    Call this after proc.wait() or proc.communicate() returns.
    """
    with _processes_lock:
        _active_processes.pop(proc.pid, None)


def _cleanup_all_processes() -> None:
    """Terminate all registered processes gracefully, then kill if needed.

    Also resets terminal to sane state after cleanup. This handles the case
    where a subprocess was killed while terminal was in raw mode (e.g.,
    drawing a progress bar).
    """
    with _processes_lock:
        for pid, proc in list(_active_processes.items()):
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            except Exception:
                # Process may have already exited
                pass
        _active_processes.clear()

    # Reset terminal to sane state - handles killed subprocesses that
    # may have left terminal in raw mode
    reset_terminal()


def _signal_handler(signum: int, frame) -> None:
    """Handle SIGTERM/SIGINT by cleaning up child processes.

    After cleanup, re-raises KeyboardInterrupt via signal.default_int_handler
    to allow normal Python exception handling. This ensures both child process
    cleanup AND proper exception propagation to calling code.
    """
    _cleanup_all_processes()
    # Re-raise to allow normal exit behavior
    signal.default_int_handler(signum, frame)


def install_signal_handlers() -> None:
    """Install signal handlers for graceful cleanup.

    Call once at CLI entry point. Safe to call multiple times.
    Registers:
    - SIGINT handler (Ctrl+C)
    - SIGTERM handler (kill command)
    - atexit handler (normal exit)
    """
    global _signal_handlers_installed
    if _signal_handlers_installed:
        return
    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)
    atexit.register(_cleanup_all_processes)
    _signal_handlers_installed = True


def check_binary(binary: str, version_flag: str = "--version") -> bool:
    """Check if a binary is available in PATH.

    Args:
        binary: Name or path of binary to check
        version_flag: Flag to pass (default: "--version")

    Returns:
        True if binary exists and runs successfully
    """
    try:
        subprocess.run(
            [binary, version_flag],
            capture_output=True,
            timeout=5,
            check=True,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return False
