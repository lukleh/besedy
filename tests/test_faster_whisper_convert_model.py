"""convert_model.sh runs the converter in a way the faster-whisper image accepts."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "backends" / "faster-whisper" / "convert_model.sh"
IMAGE = "besedy/faster-whisper:local"


def _fake_docker(bin_dir: Path) -> Path:
    """A docker that logs each call's argv and fakes the image, converter and mel check.

    FAKE_IMAGE_EXISTS=1 makes `image inspect` succeed; FAKE_MEL_EXIT is the
    mel check's exit status.
    """
    bin_dir.mkdir()
    calls_dir = bin_dir / "calls"
    calls_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(
        f"""#!/usr/bin/env bash
calls_dir='{calls_dir}'
n=$(ls "$calls_dir" | wc -l | tr -d ' ')
printf '%s\\n' "$@" > "$calls_dir/$n"
args=("$@")
if [[ " $* " == *" config --images "* ]]; then
  echo {IMAGE}
  exit 0
fi
if [[ "$1 $2" == "image inspect" ]]; then
  [[ "${{FAKE_IMAGE_EXISTS:-0}}" == 1 ]]
  exit
fi
for i in "${{!args[@]}}"; do
  if [[ "${{args[$i]}}" == --output_dir ]]; then
    out="${{args[$((i + 1))]}}"
    mkdir "$out" && touch "$out/model.bin" "$out/preprocessor_config.json"
  fi
  if [[ "${{args[$i]}}" == python && "${{args[$((i + 1))]}}" == -c ]]; then
    exit "${{FAKE_MEL_EXIT:-0}}"
  fi
done
""",
        encoding="utf-8",
    )
    docker.chmod(0o755)
    return calls_dir


def run_script(
    tmp_path: Path,
    model_dir: Path,
    *args: str,
    env_overrides: dict[str, str] | None = None,
    env_removals: tuple[str, ...] = (),
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
        *env_removals,
    ):
        env.pop(name, None)
    env.update(
        {
            "PATH": f"{tmp_path / 'bin'}:{env['PATH']}",
            "HOME": str(tmp_path / "home"),
            "XDG_CACHE_HOME": str(tmp_path / "cache"),
            "FAKE_IMAGE_EXISTS": "1",
        }
    )
    if "USER" not in env_removals:
        env["USER"] = "tester"
    env.update(env_overrides or {})
    result = subprocess.run(
        [
            "bash",
            str(SCRIPT),
            "--model",
            str(model_dir),
            "--output-dir",
            str(tmp_path / "out" / "model-ct2"),
            *args,
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


def _valid_model_dir(tmp_path: Path) -> Path:
    return _model_dir(tmp_path, "config.json", "preprocessor_config.json")


def _runs(calls: list[list[str]]) -> tuple[list[str], list[str]]:
    """The converter run and the mel check run, in that order."""
    convert = [call for call in calls if "ct2-transformers-converter" in call]
    mel_check = [call for call in calls if "python" in call and "-c" in call]
    assert len(convert) == 1 and len(mel_check) == 1, calls
    return convert[0], mel_check[0]


def _builds(calls: list[list[str]]) -> list[list[str]]:
    return [call for call in calls if call[-2:] == ["build", "faster-whisper"]]


def test_converter_keeps_ct2_config_and_gets_a_user_and_home(tmp_path: Path) -> None:
    result, calls = run_script(tmp_path, _valid_model_dir(tmp_path))

    assert result.returncode == 0, result.stdout + result.stderr
    convert, mel_check = _runs(calls)

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


def test_user_falls_back_to_the_uid_without_user_or_logname(tmp_path: Path) -> None:
    result, calls = run_script(
        tmp_path, _valid_model_dir(tmp_path), env_removals=("USER", "LOGNAME")
    )

    assert result.returncode == 0, result.stdout + result.stderr
    convert, _ = _runs(calls)
    assert f"USER=uid{os.getuid()}" in convert
    assert f"LOGNAME=uid{os.getuid()}" in convert


def test_existing_image_is_not_rebuilt(tmp_path: Path) -> None:
    result, calls = run_script(tmp_path, _valid_model_dir(tmp_path))

    assert result.returncode == 0, result.stdout + result.stderr
    assert ["image", "inspect", IMAGE] in calls
    assert _builds(calls) == []
    assert f"Using existing Docker image {IMAGE}" in result.stdout


@pytest.mark.parametrize(
    ("image_exists", "args"),
    [("0", ()), ("1", ("--rebuild",))],
    ids=["missing-image", "rebuild-flag"],
)
def test_image_is_built_when_missing_or_asked(
    tmp_path: Path, image_exists: str, args: tuple[str, ...]
) -> None:
    result, calls = run_script(
        tmp_path,
        _valid_model_dir(tmp_path),
        *args,
        env_overrides={"FAKE_IMAGE_EXISTS": image_exists},
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert len(_builds(calls)) == 1


def test_converts_into_staging_and_moves_the_result_into_place(tmp_path: Path) -> None:
    result, calls = run_script(tmp_path, _valid_model_dir(tmp_path))

    assert result.returncode == 0, result.stdout + result.stderr
    convert, mel_check = _runs(calls)
    output_dir = tmp_path / "out" / "model-ct2"
    staging_dir = convert[convert.index("--output_dir") + 1]
    assert staging_dir != str(output_dir)
    assert Path(staging_dir).parent.parent == output_dir.parent
    assert mel_check[-1] == staging_dir
    assert (output_dir / "model.bin").is_file()
    assert sorted(path.name for path in output_dir.parent.iterdir()) == ["model-ct2"]


def test_failed_mel_check_leaves_no_model_behind(tmp_path: Path) -> None:
    result, _ = run_script(
        tmp_path, _valid_model_dir(tmp_path), env_overrides={"FAKE_MEL_EXIT": "1"}
    )

    assert result.returncode == 1
    assert "Conversion complete" not in result.stdout
    assert list((tmp_path / "out").iterdir()) == []


def test_force_replaces_an_existing_model(tmp_path: Path) -> None:
    output_dir = tmp_path / "out" / "model-ct2"
    output_dir.mkdir(parents=True)
    (output_dir / "stale.bin").write_text("old", encoding="utf-8")

    result, calls = run_script(tmp_path, _valid_model_dir(tmp_path), "--force")

    assert result.returncode == 0, result.stdout + result.stderr
    convert, _ = _runs(calls)
    assert "--force" not in convert
    assert sorted(path.name for path in output_dir.iterdir()) == [
        "model.bin",
        "preprocessor_config.json",
    ]


def test_local_model_without_preprocessor_config_fails_before_docker_runs(tmp_path: Path) -> None:
    model_dir = _model_dir(tmp_path, "config.json", "processor_config.json")

    result, calls = run_script(tmp_path, model_dir)

    assert result.returncode == 1
    assert "has no preprocessor_config.json" in result.stdout
    assert "feature_extractor.save_pretrained" in result.stdout
    assert calls == []
