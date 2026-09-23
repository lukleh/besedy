"""Error reporting of the catalog CLI entry point."""

from __future__ import annotations

import argparse

import pytest

from besedy.cli import catalog as catalog_cli
from besedy.lib.runtime.backend_runtime import BackendRuntimeUnavailableError


def _parser_with_handler(handler) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.set_defaults(func=handler)
    return parser


def test_missing_backend_runtime_is_reported_without_a_traceback(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def handler(_args: argparse.Namespace) -> int:
        raise BackendRuntimeUnavailableError(
            "NeMo runs in Docker, but `docker` is not installed or not in PATH."
        )

    monkeypatch.setattr(catalog_cli, "build_parser", lambda: _parser_with_handler(handler))
    monkeypatch.setattr(catalog_cli, "install_signal_handlers", lambda: None)

    assert catalog_cli.main([]) == 1
    captured = capsys.readouterr()
    assert captured.err.strip() == (
        "Error: NeMo runs in Docker, but `docker` is not installed or not in PATH."
    )
    assert "Traceback" not in captured.err


def test_other_errors_still_propagate(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_args: argparse.Namespace) -> int:
        raise RuntimeError("unexpected")

    monkeypatch.setattr(catalog_cli, "build_parser", lambda: _parser_with_handler(handler))
    monkeypatch.setattr(catalog_cli, "install_signal_handlers", lambda: None)

    with pytest.raises(RuntimeError, match="unexpected"):
        catalog_cli.main([])
