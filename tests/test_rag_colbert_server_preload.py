"""Startup preload behaviour of the persistent ColBERT query server."""

import pytest

from besedy.lib.rag_colbert_runtime import server


@pytest.fixture
def served(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    started: list[str] = []
    monkeypatch.setattr(
        server, "serve_threading_http_server", lambda **_kwargs: started.append("served")
    )
    return started


def test_unset_preload_logs_and_serves(
    monkeypatch: pytest.MonkeyPatch, served: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv(server.PRELOAD_INDEX_ENV_VAR, raising=False)

    assert server.main([]) == 0

    assert "No ColBERT preload configured" in capsys.readouterr().out
    assert served == ["served"]


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (FileNotFoundError("gone"), "index path is missing"),
        (RuntimeError("half-written bundle"), "not loadable"),
        (KeyError("colbert_model"), "not loadable"),
    ],
)
def test_unusable_preload_is_skipped_and_the_server_still_starts(
    monkeypatch: pytest.MonkeyPatch,
    served: list[str],
    capsys: pytest.CaptureFixture[str],
    error: Exception,
    message: str,
) -> None:
    def failing_preload(_raw_index_dir: str) -> None:
        raise error

    monkeypatch.setenv(server.PRELOAD_INDEX_ENV_VAR, "/data/state/rag_colbert/x/index")
    monkeypatch.setattr(server.SERVICE, "preload", failing_preload)

    assert server.main([]) == 0

    assert message in capsys.readouterr().out
    assert served == ["served"]
