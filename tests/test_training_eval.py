"""`catalog training-eval` scores models on a dataset's test recordings (ADR 0012)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from besedy.cli import catalog as catalog_cli
from besedy.commands.catalog import training_eval
from besedy.lib import asr_evaluation as ev
from besedy.lib.runtime.backend_runtime import BackendProcessSpec

TEST_HASH = "a" * 64
OTHER_HASH = "b" * 64
TRAIN_HASH = "c" * 64


def _row(audio_hash: str, chunk: int, text: str, machine: str | None, split: str) -> dict:
    return {
        "audio": f"audio/{audio_hash[:16]}_{chunk:05d}.wav",
        "text": text,
        "machine_text": machine,
        "duration": 12.0,
        "split": split,
        "audio_hash": audio_hash,
        "workspace_id": "w",
        "chunk": chunk,
        "revision_ids": ["r"],
        "revision_origins": ["manual"],
        "source_backend": "faster-whisper/large-v3@silero_vad_v6@lang-cs",
    }


@pytest.fixture
def dataset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(catalog_cli, "install_signal_handlers", lambda: None)
    data = tmp_path / "training_export"
    (data / "audio").mkdir(parents=True)
    rows = [
        _row(TEST_HASH, 0, "Dobrý den, pane Novák.", "Dobrej den pane Novák", "test"),
        _row(TEST_HASH, 1, "Vítejte.", "Vítejte.", "test"),
        _row(OTHER_HASH, 0, "Jedna dvě tři.", "Jedna dvě tři.", "test"),
        _row(TRAIN_HASH, 0, "Trénink.", "Trénink.", "train"),
    ]
    with (data / "manifest.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (data / "dataset.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "catalog_id": "20251222_144441",
                "exported_at": "2026-11-02T00:00:00.000Z",
                "policy": {"test_recordings": [TEST_HASH, OTHER_HASH], "strip_fillers": False},
            }
        )
    )
    return data


def test_without_a_model_the_machine_baseline_is_scored_on_the_host(dataset: Path, capsys) -> None:
    assert catalog_cli.main(["training-eval", "--data", str(dataset)]) == 0
    latest = dataset / "eval" / "machine"
    assert latest.is_symlink() and latest.resolve().name.startswith("machine_")
    report = json.loads((latest / "report.json").read_text(encoding="utf-8"))
    assert report["split"] == "test" and report["rows"] == 3
    assert report["scores"] is None and report["model"] is None
    assert report["machine_baseline"]["rows"] == 3
    # "Dobrej den pane Novák" against "dobrý den pane novák": one word of eight.
    assert report["machine_baseline"]["wer"] == pytest.approx(1 / 8)
    assert report["dataset"]["catalog_id"] == "20251222_144441"
    assert report["dataset"]["test_recordings"] == [TEST_HASH, OTHER_HASH]
    assert report["git_commit"] is None or len(report["git_commit"]) >= 40
    hypotheses = (latest / "hypotheses.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(hypotheses) == 3 and json.loads(hypotheses[0])["word_errors"] == 1
    out = capsys.readouterr().out
    assert ev.MACHINE_SYSTEM in out and "12.50 %" in out


def test_recordings_limit_the_rows_and_a_dataset_without_machine_text_is_refused(
    dataset: Path, tmp_path: Path, capsys
) -> None:
    listed = tmp_path / "dev-recordings.json"
    ev.write_recordings(listed, [OTHER_HASH])
    out = tmp_path / "report"
    argv = ["training-eval", "--data", str(dataset), "--recordings", str(listed), "--out", str(out)]
    assert catalog_cli.main(argv) == 0
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["rows"] == 1 and report["recordings_source"] == str(listed)
    assert not (dataset / "eval").exists()

    rows = [json.loads(line) for line in (dataset / "manifest.jsonl").read_text().splitlines()]
    for row in rows:
        row["machine_text"] = None
    (dataset / "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    assert catalog_cli.main(["training-eval", "--data", str(dataset)]) == 1
    assert "machine_text" in capsys.readouterr().err


def test_with_a_model_the_worker_runs_in_the_faster_whisper_image(
    dataset: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_dir = tmp_path / "besedy-ct2"
    model_dir.mkdir()
    captured: dict[str, object] = {}

    def fake_build(**kwargs):
        captured["build"] = kwargs
        return BackendProcessSpec(argv=("docker", "compose", "run", "worker"), extra_env=None)

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        out = Path(kwargs_out(captured["build"]))
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text("{}")
        return subprocess.CompletedProcess(argv, 0)

    def kwargs_out(build: object) -> str:
        args = build["script_args"]  # type: ignore[index]
        return args[args.index("--out") + 1]

    monkeypatch.setattr(training_eval, "build_python_backend_process", fake_build)
    monkeypatch.setattr(training_eval.subprocess, "run", fake_run)
    monkeypatch.setattr(training_eval, "git_commit", lambda: "f" * 40)

    assert (
        catalog_cli.main(
            [
                "training-eval",
                "--data",
                str(dataset),
                "--model",
                str(model_dir),
                "--label",
                "finetuned",
                "--batch-size",
                "4",
            ]
        )
        == 0
    )
    build = captured["build"]
    assert build["backend_id"] == "faster-whisper" and build["docker_gpus"] == "all"
    assert build["script_path"] == training_eval.EVAL_SCRIPT_PATH
    assert build["input_paths"] == [dataset] and build["model_paths"] == [model_dir]
    script_args = build["script_args"]
    assert script_args[:2] == ["--data", str(dataset)]
    assert script_args[script_args.index("--model") + 1] == str(model_dir)
    assert script_args[script_args.index("--label") + 1] == "finetuned"
    assert script_args[script_args.index("--split") + 1] == "test"
    assert script_args[script_args.index("--batch-size") + 1] == "4"
    assert script_args[script_args.index("--git-commit") + 1] == "f" * 40
    assert captured["argv"] == ("docker", "compose", "run", "worker")
    latest = dataset / "eval" / "finetuned"
    assert latest.is_symlink() and build["output_paths"] == [latest.resolve()]


def test_a_relative_local_model_goes_into_the_container_as_an_absolute_path(
    dataset: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_dir = tmp_path / "models" / "besedy-ct2"
    model_dir.mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    captured: dict[str, object] = {}

    def fake_build(**kwargs):
        captured.update(kwargs)
        return BackendProcessSpec(argv=("worker",), extra_env=None)

    monkeypatch.setattr(training_eval, "build_python_backend_process", fake_build)
    monkeypatch.setattr(training_eval, "git_commit", lambda: None)
    monkeypatch.setattr(
        training_eval.subprocess,
        "run",
        lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0),
    )
    argv = ["training-eval", "--data", str(dataset), "--model", "./models/besedy-ct2"]
    assert catalog_cli.main(argv) == 0
    script_args = captured["script_args"]
    assert script_args[script_args.index("--model") + 1] == str(model_dir)
    assert captured["model_paths"] == [model_dir]


def test_the_default_label_is_the_sanitized_model_and_a_failed_worker_leaves_no_symlink(
    dataset: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        training_eval,
        "build_python_backend_process",
        lambda **kwargs: BackendProcessSpec(argv=("false",), extra_env=None),
    )
    monkeypatch.setattr(
        training_eval.subprocess,
        "run",
        lambda argv, **kwargs: subprocess.CompletedProcess(argv, 3),
    )
    assert catalog_cli.main(["training-eval", "--data", str(dataset), "--model", "large-v3"]) == 3
    assert not (dataset / "eval" / "large-v3").exists()
    # The empty directory made for the worker's mount is removed again.
    assert list((dataset / "eval").iterdir()) == []


def test_compare_prints_one_table_over_saved_reports(dataset: Path, tmp_path: Path, capsys) -> None:
    rows = ev.select_rows(ev.load_manifest(dataset), "test")
    reports = []
    for name, hyps in (
        ("large-v3", ["Dobrej den pane Novák", "Vítejte", "Jedna dvě tři"]),
        ("finetuned", ["Dobrý den pane Novák", "Vítejte", "Jedna dvě tři"]),
    ):
        report = ev.build_report(
            system=name,
            dataset=ev.dataset_identity(dataset),
            split="test",
            rows=rows,
            scores=ev.score_rows(rows, hyps),
            model={"reference": name},
            options={},
            git_commit=None,
        )
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        reports.append(path)
    assert catalog_cli.main(["training-eval", "--compare", *map(str, reports)]) == 0
    out = capsys.readouterr().out
    lines = [line for line in out.splitlines() if line.startswith("|")]
    assert [line.split("|")[1].strip() for line in lines[2:]] == [
        ev.MACHINE_SYSTEM,
        "large-v3",
        "finetuned",
    ]
    assert lines[-1].split("|")[5].strip() == "0.00 %"

    mismatched = json.loads(reports[0].read_text())
    mismatched["rows_sha256"] = "0" * 64
    reports[0].write_text(json.dumps(mismatched))
    assert catalog_cli.main(["training-eval", "--compare", *map(str, reports)]) == 1
    assert "different rows" in capsys.readouterr().err


def test_data_is_required_without_compare(capsys) -> None:
    assert catalog_cli.main(["training-eval"]) == 1
    assert "--data is required" in capsys.readouterr().err


def test_git_commit_marks_a_dirty_checkout(monkeypatch: pytest.MonkeyPatch) -> None:
    outputs = {"rev-parse": "abc\n", "status": " M file\n"}

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, stdout=outputs[argv[1]], stderr="")

    monkeypatch.setattr(training_eval.subprocess, "run", fake_run)
    assert training_eval.git_commit() == "abc-dirty"
    outputs["status"] = ""
    assert training_eval.git_commit() == "abc"
