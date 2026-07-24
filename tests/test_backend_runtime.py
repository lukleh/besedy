from __future__ import annotations

from pathlib import Path

import pytest

from besedy.core.paths import PROJECT_ROOT
from besedy.lib.runtime.backend_runtime import (
    backend_runtime_env_var_name,
    build_command_backend_process,
    build_python_backend_process,
    forward_host_env,
    resolve_backend_cache_dir,
    resolve_backend_runtime,
)


def test_backend_runtime_env_var_name_uses_upper_snake_case() -> None:
    assert backend_runtime_env_var_name("faster-whisper") == "BESEDY_FASTER_WHISPER_RUNTIME"


def test_resolve_backend_runtime_defaults_to_docker_for_migrated_backends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migrated_backends = [
        "pyannote",
        "faster-whisper",
        "qwen3-asr",
        "whisperx",
        "nemo",
    ]
    for backend_id in migrated_backends:
        monkeypatch.delenv(backend_runtime_env_var_name(backend_id), raising=False)
        assert resolve_backend_runtime(backend_id) == "docker"


def test_resolve_backend_runtime_defaults_to_isolated_for_unmigrated_backends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BESEDY_COLBERT_RUNTIME", raising=False)

    assert resolve_backend_runtime("colbert") == "isolated"
    assert resolve_backend_runtime("custom-backend") == "isolated"


def test_resolve_backend_runtime_rejects_isolated_for_migrated_backends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_NEMO_RUNTIME", "isolated")

    with pytest.raises(RuntimeError, match="Docker-only"):
        resolve_backend_runtime("nemo")


def test_forward_host_env_keeps_only_present_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HF_TOKEN", "secret")
    monkeypatch.delenv("HUGGINGFACE_TOKEN", raising=False)

    assert forward_host_env("HF_TOKEN", "HUGGINGFACE_TOKEN") == {"HF_TOKEN": "secret"}


def test_build_python_backend_process_isolated_sets_pythonpath_and_config(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    isolated_python = tmp_path / "bin" / "python"
    isolated_python.parent.mkdir(parents=True, exist_ok=True)
    isolated_python.write_text("#!/bin/sh\n")

    script_path = PROJECT_ROOT / "besedy" / "workflows" / "transcribe_nemo.py"
    process = build_python_backend_process(
        backend_id="legacy-test",
        display_name="Legacy Test",
        isolated_python=isolated_python,
        setup_script="setup_legacy_test.sh",
        script_path=script_path,
        script_args=["--help"],
        docker_service="legacy-test",
        runtime_override="isolated",
    )

    assert process.runtime == "isolated"
    assert process.argv[:2] == (str(isolated_python), str(script_path))
    assert process.extra_env is not None
    assert process.extra_env["PYTHONPATH"].startswith(str(PROJECT_ROOT))
    from besedy.config.settings import resolve_config_path

    assert process.extra_env["BESEDY_CONFIG"] == str(resolve_config_path())


def test_build_python_backend_process_docker_uses_compose_run_and_same_path_mounts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_NEMO_RUNTIME", "docker")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services:\n  nemo:\n    image: test\n")

    input_file = tmp_path / "input.wav"
    input_file.write_bytes(b"x")
    output_dir = tmp_path / "out"

    script_path = PROJECT_ROOT / "besedy" / "workflows" / "transcribe_nemo.py"
    process = build_python_backend_process(
        backend_id="nemo",
        display_name="NeMo",
        script_path=script_path,
        script_args=["--output-dir", str(output_dir), "--audio", str(input_file)],
        docker_service="nemo",
        input_paths=[input_file],
        output_paths=[output_dir],
        docker_gpus="all",
        compose_file=compose_file,
    )

    argv = list(process.argv)
    assert process.runtime == "docker"
    assert argv[:6] == ["docker", "compose", "-f", str(compose_file), "run", "--rm"]
    assert "--user" in argv
    assert any(
        item == f"{input_file.parent}:{input_file.parent}:ro"
        for item in argv
        if item.startswith(str(input_file.parent))
    )
    assert any(
        item == f"{output_dir}:{output_dir}:rw" for item in argv if item.startswith(str(output_dir))
    )
    assert "-e" in argv
    assert any(item.startswith("BESEDY_CONFIG=/run/besedy/config/besedy.toml") for item in argv)
    assert any(item.startswith("HOME=") for item in argv)
    assert any(item.startswith("USER=") for item in argv)
    assert any(item.startswith("LOGNAME=") for item in argv)
    assert any(item.startswith("HF_HOME=") for item in argv)
    assert any(item.startswith("MPLCONFIGDIR=") for item in argv)
    assert any(item.startswith("NLTK_DATA=") for item in argv)
    assert str(PROJECT_ROOT / "besedy" / "workflows" / "transcribe_nemo.py") not in argv
    assert any(item == "/workspace/besedy/besedy/workflows/transcribe_nemo.py" for item in argv)


def test_build_python_backend_process_docker_supports_gpu_requests(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_PYANNOTE_RUNTIME", "docker")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services:\n  pyannote:\n    image: test\n")

    input_file = tmp_path / "input.wav"
    input_file.write_bytes(b"x")
    output_dir = tmp_path / "out"

    process = build_python_backend_process(
        backend_id="pyannote",
        display_name="pyannote-audio",
        script_path=PROJECT_ROOT / "besedy" / "workflows" / "diarize_pyannote.py",
        script_args=["--output-dir", str(output_dir), "--audio", str(input_file)],
        docker_service="pyannote",
        input_paths=[input_file],
        output_paths=[output_dir],
        docker_gpus="all",
        compose_file=compose_file,
    )

    argv = list(process.argv)
    assert "--gpus" not in argv
    assert "pyannote" in argv


def test_build_python_backend_process_docker_rejects_cpu_mode_for_gpu_backend(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_PYANNOTE_RUNTIME", "docker")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services:\n  pyannote:\n    image: test\n")

    input_file = tmp_path / "input.wav"
    input_file.write_bytes(b"x")
    output_dir = tmp_path / "out"

    with pytest.raises(RuntimeError, match="GPU-only in Besedy"):
        build_python_backend_process(
            backend_id="pyannote",
            display_name="pyannote-audio",
            script_path=PROJECT_ROOT / "besedy" / "workflows" / "diarize_pyannote.py",
            script_args=["--output-dir", str(output_dir), "--audio", str(input_file)],
            docker_service="pyannote",
            input_paths=[input_file],
            output_paths=[output_dir],
            docker_gpus=None,
            compose_file=compose_file,
        )


def test_resolve_backend_cache_dir_prefers_xdg_cache_home(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_CACHE_HOME", "/tmp/besedy-cache")
    monkeypatch.delenv("BESEDY_WHISPERX_CACHE_DIR", raising=False)

    assert resolve_backend_cache_dir("whisperx") == Path("/tmp/besedy-cache/besedy/whisperx")


def test_build_command_backend_process_docker_uses_compose_run_and_same_path_mounts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services:\n  legacy-test:\n    image: test\n")

    input_file = tmp_path / "input.wav"
    input_file.write_bytes(b"x")
    output_dir = tmp_path / "out"

    process = build_command_backend_process(
        backend_id="legacy-test",
        display_name="Legacy Test",
        host_argv=["/usr/bin/legacy-test", str(input_file), "-o", str(output_dir)],
        docker_argv=["legacy-test", str(input_file), "-o", str(output_dir)],
        docker_service="legacy-test",
        runtime_override="docker",
        extra_env={"DEVICE": "cpu"},
        input_paths=[input_file],
        output_paths=[output_dir],
        compose_file=compose_file,
    )

    argv = list(process.argv)
    assert process.runtime == "docker"
    assert argv[:6] == ["docker", "compose", "-f", str(compose_file), "run", "--rm"]
    assert any(
        item == f"{input_file.parent}:{input_file.parent}:ro"
        for item in argv
        if item.startswith(str(input_file.parent))
    )
    assert any(
        item == f"{output_dir}:{output_dir}:rw" for item in argv if item.startswith(str(output_dir))
    )
    assert any(item == "DEVICE=cpu" for item in argv)
    assert argv[-5:] == [
        "legacy-test",
        "legacy-test",
        str(input_file),
        "-o",
        str(output_dir),
    ]


def test_build_command_backend_process_docker_supports_gpu_requests(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_PYANNOTE_RUNTIME", "docker")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services:\n  pyannote:\n    image: test\n")

    input_dir = tmp_path / "in"
    input_dir.mkdir()
    output_dir = tmp_path / "out"

    process = build_command_backend_process(
        backend_id="pyannote",
        display_name="pyannote-audio",
        host_argv=["pyannote", str(input_dir), str(output_dir)],
        docker_argv=["pyannote", str(input_dir), str(output_dir)],
        docker_service="pyannote",
        compose_file=compose_file,
        input_paths=[input_dir],
        output_paths=[output_dir],
        docker_gpus="all",
    )

    argv = list(process.argv)
    assert argv[:6] == ["docker", "compose", "-f", str(compose_file), "run", "--rm"]
    assert "--gpus" not in argv
    assert "pyannote" in argv


def test_build_command_backend_process_docker_rejects_cpu_mode_for_gpu_backend(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_PYANNOTE_RUNTIME", "docker")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services:\n  pyannote:\n    image: test\n")

    input_dir = tmp_path / "in"
    input_dir.mkdir()
    output_dir = tmp_path / "out"

    with pytest.raises(RuntimeError, match="GPU-only in Besedy"):
        build_command_backend_process(
            backend_id="pyannote",
            display_name="pyannote-audio",
            host_argv=["pyannote", str(input_dir), str(output_dir), "--device", "cpu"],
            docker_argv=["pyannote", str(input_dir), str(output_dir), "--device", "cpu"],
            docker_service="pyannote",
            compose_file=compose_file,
            input_paths=[input_dir],
            output_paths=[output_dir],
            docker_gpus=None,
        )
