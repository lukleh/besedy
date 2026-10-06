"""catalog create -> run-pipeline on real audio, with only the backend containers faked.

Every catalog step runs for real (ffprobe/ffmpeg for the catalog, loudness,
staging and archive; the transcript export in Python). The GPU backends run in
Docker in production, so ``docker`` invocations are replaced by a fake that
writes what the container would: a ``transcript.json`` per staged file for
faster-whisper and a ``speakers.json`` for pyannote. The argv the pipeline
builds for those containers still has to name the right output directory and
audio files, or the fake writes nothing and the assertions fail.

CI runs this file in its own step (it needs ffmpeg, hence ``integration``).
"""

from __future__ import annotations

import csv
import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from besedy.cli import catalog as catalog_cli
from besedy.config import settings
from besedy.core.paths import (
    PYANNOTE_DIARIZATION_MODEL_NAME,
    require_valid_hash_stem,
    resolve_transcripts_parent,
)
from besedy.lib.audio import normalize as normalize_module
from besedy.lib.runtime import backend_runtime
from besedy.lib.workflow import runner as runner_module
from besedy.lib.workflow.config import get_transcription_workflows, select_transcription_workflow
from besedy.lib.workflow.paths import (
    path_builder,
    sanitize_model_identifier,
    setup_diarization_output_dir,
)
from tests.helpers.audio import create_tone_wav
from tests.helpers.transcript import (
    create_diarization_json,
    create_transcript_with_words,
    write_transcript_json,
)

pytestmark = pytest.mark.integration

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((REPO_ROOT / "contracts" / "catalog-csv.json").read_text(encoding="utf-8"))
FASTER_WHISPER_SCRIPT = "/besedy/workflows/transcribe_faster_whisper.py"
PYANNOTE_SCRIPT = "/besedy/workflows/diarize_pyannote.py"
CLUSTER_SCRIPT = "/besedy/core/cluster_speakers.py"

PIPELINE_WORKFLOW = """\
[[transcription_workflows]]
workflow_id = "faster-whisper"
workflow_label = "faster-whisper"
model = "large-v3"
vad_model = "silero_vad_v6"
language = "cs"

"""


def _write_config(tmp_path: Path, text_root: Path, audio_root: Path) -> Path:
    """The example config with one pipeline transcription workflow."""
    example = (REPO_ROOT / "besedy.toml.example").read_text(encoding="utf-8")
    start = example.index("[[transcription_workflows]]")
    end = example.index("[vad]")
    config_text = example[:start] + PIPELINE_WORKFLOW + example[end:]
    for key, value in (("audio_artifacts_dir", audio_root), ("text_data_dir", text_root)):
        placeholder = f'{key} = ""'
        assert config_text.count(placeholder) == 1, f"{placeholder} not found once in the example"
        config_text = config_text.replace(placeholder, f'{key} = "{value}"')
    path = tmp_path / "besedy.toml"
    path.write_text(config_text, encoding="utf-8")
    return path


def _script_args(argv: list[str], script_suffix: str) -> list[str] | None:
    for index, token in enumerate(argv):
        if token.endswith(script_suffix):
            return argv[index + 1 :]
    return None


def _option(args: list[str], name: str) -> str:
    return args[args.index(name) + 1]


def _optional(args: list[str], name: str) -> str | None:
    return _option(args, name) if name in args else None


def _audio_files(args: list[str]) -> list[Path]:
    start = args.index("--audio") + 1
    files: list[Path] = []
    for token in args[start:]:
        if token.startswith("--"):
            break
        files.append(Path(token))
    return files


class FakeBackends:
    """Stand-in for `docker compose run` of the backend images."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def run(self, argv: list[str]) -> int:
        if (args := _script_args(argv, FASTER_WHISPER_SCRIPT)) is not None:
            self.calls.append("faster-whisper")
            # Name the output folder from the argv the way the script does
            # (resolve_bundle_root in besedy/workflows/transcribe_faster_whisper.py).
            workflow = replace(
                select_transcription_workflow("faster-whisper"),
                model_name=_option(args, "--model"),
                vad_model=_optional(args, "--vad-model"),
                align_model=None,
                language=_option(args, "--language"),
            )
            bundle_root = Path(_option(args, "--output-dir")) / workflow.output_component(
                sanitize_model_identifier
            )
            for audio in _audio_files(args):
                write_transcript_json(
                    bundle_root / require_valid_hash_stem(audio) / "transcript.json",
                    create_transcript_with_words(words=["Dobrý", "den", audio.stem[:8]]),
                )
            return 0
        if (args := _script_args(argv, PYANNOTE_SCRIPT)) is not None:
            self.calls.append("pyannote")
            output_root = Path(_option(args, "--output-dir"))
            for audio in _audio_files(args):
                output_dir, _ = setup_diarization_output_dir(
                    output_root, audio, PYANNOTE_DIARIZATION_MODEL_NAME
                )
                (output_dir / "speakers.json").write_text(
                    json.dumps(create_diarization_json(["SPEAKER_00", "SPEAKER_01"])),
                    encoding="utf-8",
                )
            return 0
        if _script_args(argv, CLUSTER_SCRIPT) is not None:
            self.calls.append("cluster-speakers")
            return 0
        raise AssertionError(f"unexpected container run: {argv}")


@pytest.fixture
def pipeline_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    # Both data roots exist on a real host; the pipeline does not create them.
    text_root = tmp_path / "text"
    audio_root = tmp_path / "audio"
    text_root.mkdir()
    audio_root.mkdir()
    # The data roots come from the config only, as on a host: conftest's
    # session-wide overrides would otherwise win over it.
    monkeypatch.delenv("BESEDY_TEXT_DATA_ROOT", raising=False)
    monkeypatch.delenv("BESEDY_AUDIO_ARTIFACTS_ROOT", raising=False)
    monkeypatch.setenv("BESEDY_CONFIG", str(_write_config(tmp_path, text_root, audio_root)))
    # Keep every XDG directory the run touches inside tmp_path: building a
    # backend argv creates cache directories under XDG_CACHE_HOME.
    for name in ("XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"):
        monkeypatch.setenv(name, str(tmp_path / name.lower()))
    # Staging writes ffmpeg logs to a directory resolved at import time, so
    # the XDG_STATE_HOME above is too late for it.
    monkeypatch.setattr(normalize_module, "CONVERSION_LOG_DIR", tmp_path / "logs" / "ffmpeg")
    settings.reset_config()

    backends = FakeBackends()
    real_run = subprocess.run
    real_popen = subprocess.Popen

    def fake_run(argv, *args, **kwargs):  # type: ignore[no-untyped-def]
        if list(argv)[:1] == ["docker"]:
            return subprocess.CompletedProcess(argv, backends.run(list(argv)))
        return real_run(argv, *args, **kwargs)

    def fake_popen(argv, *args, **kwargs):  # type: ignore[no-untyped-def]
        if list(argv)[:1] == ["docker"]:
            code = backends.run(list(argv))
            return real_popen([sys.executable, "-c", f"raise SystemExit({code})"])
        return real_popen(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    # Docker itself may be absent where the test runs; the containers are faked.
    monkeypatch.setattr(backend_runtime, "_docker_runtime_ready", lambda **_kwargs: (True, None))
    # The CLI and the workflow launcher install process-wide signal handlers.
    monkeypatch.setattr(catalog_cli, "install_signal_handlers", lambda: None)
    monkeypatch.setattr(runner_module, "install_signal_handlers", lambda: None)
    # Two pyannote groups regardless of the host's GPU, so the parallel
    # (Popen) launch path runs and the launch sequence is fixed.
    monkeypatch.setattr(runner_module, "calculate_parallel_instances", lambda *_a, **_k: 2)
    yield tmp_path, text_root, audio_root, backends
    settings.reset_config()


def _header(path: Path) -> list[str]:
    with path.open(encoding="utf-8", newline="") as handle:
        return next(csv.reader(handle))


def _rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def test_catalog_create_then_run_pipeline_produces_what_the_web_reads(
    pipeline_env, require_ffmpeg
) -> None:  # type: ignore[no-untyped-def]
    tmp_path, text_root, _audio_root, backends = pipeline_env
    sources = tmp_path / "sources"
    sources.mkdir()
    create_tone_wav(sources / "talk-a.wav", frequency=440.0, duration_seconds=3.0)
    create_tone_wav(sources / "talk-b.wav", frequency=660.0, duration_seconds=3.0)

    assert catalog_cli.main(["create", str(sources)]) == 0
    (catalog_csv,) = sorted((text_root / "catalogs").glob("audio_catalog_2*_*[0-9].csv"))
    timestamp = catalog_csv.stem.removeprefix("audio_catalog_")

    assert (
        catalog_cli.main(["run-pipeline", "--csv", str(catalog_csv), "--skip-rag-colbert-index"])
        == 0
    )

    # Catalog CSVs carry every column the web sync reads.
    metadata_rows = _rows(catalog_csv)
    hashes = sorted(row["Hash"] for row in metadata_rows)
    assert len(hashes) == 2 and len(set(hashes)) == 2
    assert set(CONTRACT["metadata"]) <= set(_header(catalog_csv))
    assert {row["Hash Algorithm"] for row in metadata_rows} == {CONTRACT["hashAlgorithm"]}
    archived_csv = catalog_csv.with_name(f"audio_catalog_{timestamp}_loudness_archived.csv")
    assert set(CONTRACT["archived"]) <= set(_header(archived_csv))

    # Staged 16 kHz WAVs and both playback copies for every recording.
    normalized = _rows(catalog_csv.with_name(f"audio_catalog_{timestamp}_loudness_normalized.csv"))
    assert sorted(row["Hash"] for row in normalized) == hashes
    assert all(Path(row["Full Path"]).is_file() for row in normalized)
    archived = {row["Hash"]: row for row in _rows(archived_csv)}
    assert sorted(archived) == hashes
    for row in archived.values():
        assert Path(row["Compressed Path"]).suffix == ".webm"
        assert Path(row["Compressed Path"]).is_file()
        assert Path(row["Compressed AAC Path"]).is_file()

    # Transcripts, their exported sidecars, and diarization per recording.
    transcripts_root = resolve_transcripts_parent() / f"transcripts_{timestamp}"
    (workflow,) = get_transcription_workflows(workflow_id="faster-whisper")
    for audio_hash in hashes:
        transcript = path_builder(workflow).artifact_path(audio_hash, transcripts_root)
        assert transcript.is_file()
        for suffix in ("txt", "srt", "vtt"):
            assert (transcript.parent / f"transcript.{suffix}").stat().st_size > 0
        speakers = (
            transcripts_root
            / "speaker_diarization"
            / PYANNOTE_DIARIZATION_MODEL_NAME
            / audio_hash
            / "speakers.json"
        )
        assert speakers.is_file()

    assert backends.calls == ["faster-whisper", "pyannote", "pyannote", "cluster-speakers"]
