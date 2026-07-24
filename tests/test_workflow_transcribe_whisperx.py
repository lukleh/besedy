from __future__ import annotations

from pathlib import Path

import pytest

from besedy.workflows.transcribe_whisperx import (
    MAX_CONSECUTIVE_RETRY_FAILURES,
    _resolve_whisperx_cli,
    _retry_missing_outputs_individually,
    _run_whisperx,
)


class TestRetryMissingOutputsIndividually:
    """Per-file retry after a failed batch, with a systemic-failure guard."""

    @staticmethod
    def _audio_paths(tmp_path: Path, count: int) -> list[Path]:
        paths = []
        for index in range(count):
            stem = f"{index:x}".rjust(64, "a")
            path = tmp_path / f"{stem}.wav"
            path.touch()
            paths.append(path)
        return paths

    def test_gives_up_early_when_batch_produced_nothing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        audio_paths = self._audio_paths(tmp_path, 10)
        raw_dir = tmp_path / "raw"
        raw_dir.mkdir()
        calls: list[Path] = []

        monkeypatch.setattr(
            "besedy.workflows.transcribe_whisperx._run_whisperx",
            lambda paths, _raw_dir, **_kwargs: calls.append(paths[0]) or 1,
        )

        _retry_missing_outputs_individually(audio_paths, raw_dir)

        assert len(calls) == MAX_CONSECUTIVE_RETRY_FAILURES

    def test_zero_exit_without_output_still_counts_as_failure(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        audio_paths = self._audio_paths(tmp_path, 10)
        raw_dir = tmp_path / "raw"
        raw_dir.mkdir()
        calls: list[Path] = []

        monkeypatch.setattr(
            "besedy.workflows.transcribe_whisperx._run_whisperx",
            lambda paths, _raw_dir, **_kwargs: calls.append(paths[0]) or 0,
        )

        _retry_missing_outputs_individually(audio_paths, raw_dir)

        assert len(calls) == MAX_CONSECUTIVE_RETRY_FAILURES

    def test_batch_output_disarms_the_systemic_guard(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        audio_paths = self._audio_paths(tmp_path, 8)
        raw_dir = tmp_path / "raw"
        raw_dir.mkdir()
        # The batch run got through one file before aborting, so the failure
        # is per-file: every missing output must be retried.
        (raw_dir / f"{audio_paths[0].stem}.json").write_text("{}", encoding="utf-8")
        calls: list[Path] = []

        monkeypatch.setattr(
            "besedy.workflows.transcribe_whisperx._run_whisperx",
            lambda paths, _raw_dir, **_kwargs: calls.append(paths[0]) or 1,
        )

        _retry_missing_outputs_individually(audio_paths, raw_dir)

        assert len(calls) == len(audio_paths) - 1

    def test_first_retry_success_disarms_the_systemic_guard(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        audio_paths = self._audio_paths(tmp_path, 8)
        raw_dir = tmp_path / "raw"
        raw_dir.mkdir()
        calls: list[Path] = []

        def fake_run(paths: list[Path], _raw_dir: Path, **_kwargs) -> int:
            calls.append(paths[0])
            if len(calls) == 1:
                (raw_dir / f"{paths[0].stem}.json").write_text("{}", encoding="utf-8")
                return 0
            return 1

        monkeypatch.setattr("besedy.workflows.transcribe_whisperx._run_whisperx", fake_run)

        _retry_missing_outputs_individually(audio_paths, raw_dir)

        assert len(calls) == len(audio_paths)


def test_resolve_whisperx_cli_uses_env_override(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    cli_path = tmp_path / "whisperx"
    cli_path.write_text("", encoding="utf-8")
    monkeypatch.setenv("BESEDY_WHISPERX_CLI", str(cli_path))

    assert _resolve_whisperx_cli() == str(cli_path)


def test_resolve_whisperx_cli_falls_back_to_path_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BESEDY_WHISPERX_CLI", raising=False)
    monkeypatch.setattr(
        "besedy.workflows.transcribe_whisperx.shutil.which", lambda _: "/usr/bin/whisperx"
    )

    assert _resolve_whisperx_cli() == "/usr/bin/whisperx"


def test_resolve_whisperx_cli_raises_for_missing_override(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    missing_path = tmp_path / "missing-whisperx"
    monkeypatch.setenv("BESEDY_WHISPERX_CLI", str(missing_path))

    with pytest.raises(RuntimeError, match="BESEDY_WHISPERX_CLI does not exist"):
        _resolve_whisperx_cli()


def test_run_whisperx_auto_language_uses_upstream_detection_and_alignment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: dict[str, list[str]] = {}

    class DummyProcess:
        def wait(self) -> int:
            return 0

    def fake_popen(cmd: list[str], *, cwd: str) -> DummyProcess:
        captured["cmd"] = cmd
        return DummyProcess()

    monkeypatch.setattr(
        "besedy.workflows.transcribe_whisperx._resolve_whisperx_cli",
        lambda: "/usr/bin/whisperx",
    )
    monkeypatch.setattr("besedy.workflows.transcribe_whisperx.subprocess.Popen", fake_popen)
    monkeypatch.setattr("besedy.workflows.transcribe_whisperx.register_process", lambda _: None)
    monkeypatch.setattr("besedy.workflows.transcribe_whisperx.unregister_process", lambda _: None)

    result = _run_whisperx(
        [tmp_path / "audio.wav"],
        tmp_path / "raw",
        model="large-v3",
        language=None,
        align_model=None,
        vad_method="silero",
        compute_type="float16",
        batch_size=8,
    )

    assert result == 0
    assert "--language" not in captured["cmd"]
    assert "--align_model" not in captured["cmd"]
