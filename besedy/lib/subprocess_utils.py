"""Bulletproof subprocess utilities with signal handling.

This module provides robust subprocess execution patterns that:
1. Continue execution even if some subprocesses fail
2. Properly return stdio control to shell when script finishes
3. Clean up child processes on SIGINT/SIGTERM

Usage:
    from besedy.lib.subprocess_utils import (
        install_signal_handlers,
        run_batch,
        run_parallel,
        check_binary,
        stream_lines,
        safe_decode,
    )

    # Call once at CLI entry point
    install_signal_handlers()

    # Run commands, continuing on failures
    successes, failures = run_batch([
        ("task1", ["python", "script1.py"]),
        ("task2", ["python", "script2.py"]),
    ])

    if failures:
        for result in failures:
            print(f"{result.label} failed: {result.stderr}")
"""

from __future__ import annotations

import atexit
import signal
import subprocess
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

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


def save_terminal_state() -> list | None:
    """Save current terminal attributes if connected to a TTY.

    Returns:
        Terminal attributes list, or None if not a TTY or termios unavailable.
    """
    if not _HAS_TERMIOS:
        return None
    try:
        if sys.stdin.isatty():
            return termios.tcgetattr(sys.stdin)
    except (termios.error, OSError):
        pass
    return None


def restore_terminal_state(attrs: list | None) -> None:
    """Restore terminal attributes if previously saved.

    Args:
        attrs: Terminal attributes from save_terminal_state(), or None.
    """
    if attrs is None or not _HAS_TERMIOS:
        return
    try:
        if sys.stdin.isatty():
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, attrs)
    except (termios.error, OSError):
        pass


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


@dataclass
class SubprocessResult:
    """Unified result from subprocess execution."""

    label: str
    returncode: int
    stdout: str = ""
    stderr: str = ""

    @property
    def success(self) -> bool:
        """Return True if process exited with code 0."""
        return self.returncode == 0


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


# Aliases for internal use
_register_process = register_process
_unregister_process = unregister_process


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


def run_batch(
    commands: list[tuple[str, list[str]]],
    *,
    cwd: Path | None = None,
    env: dict | None = None,
    timeout: float | None = None,
    on_start: Callable[[str], None] | None = None,
    on_complete: Callable[[SubprocessResult], None] | None = None,
) -> tuple[list[SubprocessResult], list[SubprocessResult]]:
    """Run commands sequentially, continuing even if some fail.

    Args:
        commands: List of (label, argv) tuples
        cwd: Working directory for all commands
        env: Environment variables (replaces current env if provided)
        timeout: Timeout in seconds per command (None = no timeout)
        on_start: Callback when command starts, receives label
        on_complete: Callback when command completes, receives result

    Returns:
        Tuple of (successes, failures) - both are lists of SubprocessResult
    """
    successes: list[SubprocessResult] = []
    failures: list[SubprocessResult] = []

    for label, argv in commands:
        if on_start:
            on_start(label)
        try:
            result = subprocess.run(
                argv,
                cwd=cwd,
                env=env,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
            res = SubprocessResult(
                label=label,
                returncode=result.returncode,
                stdout=safe_decode(result.stdout),
                stderr=safe_decode(result.stderr),
            )
        except OSError as exc:
            res = SubprocessResult(label=label, returncode=-1, stderr=str(exc))
        except subprocess.TimeoutExpired as exc:
            res = SubprocessResult(
                label=label,
                returncode=-1,
                stderr=f"Timed out after {timeout} seconds",
                stdout=safe_decode(exc.stdout) if exc.stdout else "",
            )

        if res.success:
            successes.append(res)
        else:
            failures.append(res)

        if on_complete:
            on_complete(res)

    return successes, failures


def run_parallel(
    commands: list[tuple[str, list[str]]],
    *,
    cwd: Path | None = None,
    env: dict | None = None,
    live_output: bool = True,
    on_start: Callable[[str], None] | None = None,
    on_complete: Callable[[SubprocessResult], None] | None = None,
) -> tuple[list[SubprocessResult], list[SubprocessResult]]:
    """Run commands in parallel, continuing even if some fail.

    Signal-safe: registered processes are cleaned up on SIGINT/SIGTERM.
    Terminal state is reset by _cleanup_all_processes() if processes are killed.

    Args:
        commands: List of (label, argv) tuples
        cwd: Working directory for all commands
        env: Environment variables (replaces current env if provided)
        live_output: If True, output goes to terminal. If False, captured.
        on_start: Callback when command starts, receives label
        on_complete: Callback when command completes, receives result

    Returns:
        Tuple of (successes, failures) - both are lists of SubprocessResult
    """
    processes: list[tuple[str, subprocess.Popen]] = []
    failures: list[SubprocessResult] = []

    # Launch all processes
    for label, argv in commands:
        if on_start:
            on_start(label)
        try:
            proc = subprocess.Popen(
                argv,
                cwd=cwd,
                env=env,
                stdout=None if live_output else subprocess.PIPE,
                stderr=None if live_output else subprocess.PIPE,
            )
            _register_process(proc)
            processes.append((label, proc))
        except OSError as exc:
            failures.append(SubprocessResult(label=label, returncode=-1, stderr=str(exc)))

    # Collect all results (ensures stdio returned to shell)
    successes: list[SubprocessResult] = []
    for label, proc in processes:
        if live_output:
            proc.wait()
            stdout, stderr = "", ""
        else:
            stdout_bytes, stderr_bytes = proc.communicate()
            stdout = safe_decode(stdout_bytes)
            stderr = safe_decode(stderr_bytes)

        _unregister_process(proc)
        res = SubprocessResult(
            label=label,
            returncode=proc.returncode,
            stdout=stdout,
            stderr=stderr,
        )

        if res.success:
            successes.append(res)
        else:
            failures.append(res)

        if on_complete:
            on_complete(res)

    return successes, failures


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


def stream_lines(
    argv: list[str],
    line_handler: Callable[[str], None],
    *,
    cwd: Path | None = None,
    timeout: float | None = None,
) -> int:
    """Stream subprocess stdout line-by-line with guaranteed cleanup.

    Useful for processing output incrementally (e.g., progress updates).
    Signal-safe: registered for cleanup on SIGINT/SIGTERM.

    Args:
        argv: Command and arguments
        line_handler: Callback for each line (newline stripped)
        cwd: Working directory
        timeout: Timeout for final wait (default: 5 seconds)

    Returns:
        Process exit code
    """
    proc = subprocess.Popen(
        argv,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    _register_process(proc)
    try:
        if proc.stdout:
            for line in proc.stdout:
                line_handler(line.rstrip("\n"))
    finally:
        try:
            proc.wait(timeout=timeout or 5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        _unregister_process(proc)
    return proc.returncode
