"""convert_model.sh runs the converter in a way the faster-whisper image accepts."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "backends" / "faster-whisper" / "convert_model.sh"


def _fake_docker(bin_dir: Path) -> Path:
    """A docker that logs each call's argv and fakes the converter's model.bin."""
    bin_dir.mkdir()
    calls_dir = bin_dir / "calls"
    calls_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(
        f"""#!/usr/bin/env bash
n=$(ls {calls_dir} | wc -l | tr -d ' ')
printf '%s\\n' "$@" > {calls_dir}/$n
args=("$@")
for i in "${{!args[@]}}"; do
  if [[ "${{args[$i]}}" == --output_dir ]]; then
    out="${{args[$((i + 1))]}}"
    mkdir -p "$out" && touch "$out/model.bin"
  fi
done
""",
        encoding="utf-8",
    )
    docker.chmod(0o755)
    return calls_dir


def run_script(
    tmp_path: Path, model_dir: Path
) -> tuple[subprocess.CompletedProcess[str], list[list[str]]]:
    calls_dir = _fake_docker(tmp_path / "bin")
    env = os.environ.copy()
    for name in (
        "HF_HOME",
        "HF_HUB_CACHE",
        "TRANSFORMERS_CACHE",
        "TORCH_HOME",
        "BESEDY_DOCKER_HOME",
        "HF_TOKEN",
    ):
        env.pop(name, None)
    env.update(
        {
            "PATH": f"{tmp_path / 'bin'}:{env['PATH']}",
            "HOME": str(tmp_path / "home"),
            "XDG_CACHE_HOME": str(tmp_path / "cache"),
            "USER": "tester",
        }
    )
    result = subprocess.run(
        [
            "bash",
            str(SCRIPT),
            "--model",
            str(model_dir),
            "--output-dir",
            str(tmp_path / "out" / "model-ct2"),
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    calls = [
        (calls_dir / name).read_text(encoding="utf-8").splitlines()
        for name in sorted(os.listdir(calls_dir), key=int)
    ]
    return result, calls


def _model_dir(tmp_path: Path, *files: str) -> Path:
    model_dir = tmp_path / "hf-model"
    model_dir.mkdir()
    for name in files:
        (model_dir / name).write_text("{}", encoding="utf-8")
    return model_dir


def test_converter_keeps_ct2_config_and_gets_a_user_and_home(tmp_path: Path) -> None:
    model_dir = _model_dir(tmp_path, "config.json", "preprocessor_config.json")

    result, calls = run_script(tmp_path, model_dir)

    assert result.returncode == 0, result.stdout + result.stderr
    build, convert, mel_check = calls
    assert build[-2:] == ["build", "faster-whisper"]

    copy_files = convert[convert.index("--copy_files") + 1 :]
    assert "preprocessor_config.json" in copy_files
    assert "config.json" not in copy_files

    docker_home = str(tmp_path / "cache" / "home")
    for run in (convert, mel_check):
        assert "--user" in run
        assert "USER=tester" in run
        assert "LOGNAME=tester" in run
        assert f"HOME={docker_home}" in run
        assert f"{docker_home}:{docker_home}:rw" in run
    service = mel_check.index("faster-whisper")
    assert mel_check[service + 1 : service + 3] == ["python", "-c"]


def test_local_model_without_preprocessor_config_fails_before_docker_runs(tmp_path: Path) -> None:
    model_dir = _model_dir(tmp_path, "config.json", "processor_config.json")

    result, calls = run_script(tmp_path, model_dir)

    assert result.returncode == 1
    assert "has no preprocessor_config.json" in result.stdout
    assert "feature_extractor.save_pretrained" in result.stdout
    assert calls == []
