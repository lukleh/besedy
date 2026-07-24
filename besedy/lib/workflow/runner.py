"Workflow orchestration for transcription and diarization."

from __future__ import annotations

import json
import math
import os
import shlex
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from besedy.core.paths import (
    PROJECT_ROOT,
    hash_component_from_sha,
    resolve_project_path,
)
from besedy.lib.audio.types import PreparedEntry
from besedy.lib.runtime.backend_runtime import (
    build_python_backend_process,
    check_python_backend_runtime_ready,
    forward_host_env,
    resolve_local_model_path,
)
from besedy.lib.subprocess_utils import (
    install_signal_handlers,
    register_process,
    unregister_process,
)
from besedy.lib.workflow.common import WorkflowCommand
from besedy.lib.workflow.config import WorkflowConfig, get_workflow_config
from besedy.lib.workflow.paths import path_builder, sanitize_model_identifier
from besedy.lib.workflow.vram import calculate_parallel_instances

# Workflow Script Paths
NEMO_VAD_SCRIPT_PATH = PROJECT_ROOT / "besedy" / "workflows" / "transcribe_nemo.py"
NEMO_WHISPERX_ALIGN_SCRIPT_PATH = (
    PROJECT_ROOT / "besedy" / "workflows" / "align_nemo_with_whisperx.py"
)
FASTER_WHISPER_SCRIPT_PATH = PROJECT_ROOT / "besedy" / "workflows" / "transcribe_faster_whisper.py"
QWEN3_ASR_SCRIPT_PATH = PROJECT_ROOT / "besedy" / "workflows" / "transcribe_qwen3_asr.py"
WHISPERX_SCRIPT_PATH = PROJECT_ROOT / "besedy" / "workflows" / "transcribe_whisperx.py"
PYANNOTE_DIARIZATION_SCRIPT_PATH = PROJECT_ROOT / "besedy" / "workflows" / "diarize_pyannote.py"

WorkflowSpec = WorkflowCommand
_SENSITIVE_ENV_TOKENS = ("TOKEN", "SECRET", "PASSWORD", "KEY")


@dataclass(frozen=True)
class TranscriptionJob:
    config: WorkflowConfig
    hashes: set[str] = field(default_factory=set)
    align_hashes: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class WorkflowRunConfig:
    output_root: Path
    cpu: bool = False
    overwrite: bool = False
    enable_pyannote_diarization: bool = False
    nemo_parallel: int | None = None
    nemo_beam_size: int = 2
    nemo_softmax_temperature: float = 1.0
    nemo_beam_length_penalty: float | None = None
    nemo_beam_max_generation_delta: int | None = None
    pyannote_parallel: int | None = None
    pyannote_min_speakers: int | None = None
    pyannote_max_speakers: int | None = None
    pyannote_clustering_threshold: float | None = None


def resolve_output_root(output_root: Path) -> Path:
    return output_root if output_root.is_absolute() else resolve_project_path(output_root)


def _local_model_paths(*values: str | Path | None) -> list[Path | str]:
    paths: list[Path | str] = []
    for value in values:
        resolved = resolve_local_model_path(value)
        if resolved is not None:
            paths.append(resolved)
    return paths


def _metadata_audio_paths(*metadata_paths: Path) -> list[Path]:
    paths: list[Path] = []
    seen: set[Path] = set()
    for metadata_path in metadata_paths:
        if not metadata_path.exists():
            continue
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        meta = payload.get("meta")
        if not isinstance(meta, dict):
            continue
        audio_path = meta.get("audio_filepath")
        if not audio_path:
            continue
        resolved = Path(str(audio_path)).expanduser()
        if resolved in seen:
            continue
        seen.add(resolved)
        paths.append(resolved)
    return paths


def _workflow_from_backend_process(
    *,
    label: str,
    process,
    parallel_group: str | None = None,
) -> WorkflowSpec:
    return WorkflowSpec(
        label=label,
        argv=process.argv,
        extra_env=process.extra_env,
        parallel_group=parallel_group,
    )


def _redact_printable_argv(argv: Sequence[str]) -> str:
    redacted: list[str] = []
    redact_next_env = False

    for part in argv:
        if redact_next_env:
            key, sep, value = part.partition("=")
            if sep and any(token in key.upper() for token in _SENSITIVE_ENV_TOKENS):
                redacted.append(f"{key}=***REDACTED***")
            else:
                redacted.append(part)
            redact_next_env = False
            continue

        redacted.append(part)
        if part == "-e":
            redact_next_env = True

    return " ".join(shlex.quote(part) for part in redacted)


def artifact_exists(workflow_id: str, output_root: Path, hash_component: str) -> bool:
    """Check if artifact exists for workflow and hash."""
    return path_builder(workflow_id).artifact_exists(hash_component, output_root)


def build_workflows(
    prepared: Sequence[PreparedEntry],
    config: WorkflowRunConfig,
    *,
    transcription_jobs: Sequence[TranscriptionJob],
    hashes_for_pyannote_diarization: set[str],
) -> list[WorkflowSpec]:
    """Build workflow specifications for transcription and diarization pipelines."""
    if not prepared:
        return []

    def _as_path_args(*paths: Path | str) -> list[Path | str]:
        return list(paths)

    output_root = resolve_output_root(config.output_root)

    workflows: list[WorkflowSpec] = []

    nemo_jobs = [
        job
        for job in transcription_jobs
        if job.config.workflow_id in {"canary-nemo", "canary-nemo-beam"}
    ]
    whisperx_jobs = [job for job in transcription_jobs if job.config.workflow_id == "whisperx"]
    faster_jobs = [job for job in transcription_jobs if job.config.workflow_id == "faster-whisper"]
    qwen_jobs = [job for job in transcription_jobs if job.config.workflow_id == "qwen3-asr"]

    if nemo_jobs:
        for job in nemo_jobs:
            cfg = job.config
            nemo_entries = [
                entry for entry in prepared if hash_component_from_sha(entry.sha256) in job.hashes
            ]
            has_align = cfg.decode_strategy == "beam" and bool(job.align_hashes)
            if not nemo_entries and not has_align:
                continue

            output_component = cfg.output_component(sanitize_model_identifier)
            base_label = f"{cfg.workflow_label}-{output_component}"
            script_path = NEMO_VAD_SCRIPT_PATH
            extra_args = ["--keep-vad-temp", "--save-vad-debug"]
            workflow_root = output_root / cfg.workflow_label
            workflow_root.mkdir(parents=True, exist_ok=True)

            if nemo_entries:
                nemo_parallel_config = (
                    config.nemo_parallel
                    if config.nemo_parallel is not None
                    else calculate_parallel_instances(cfg)
                )
                requested_parallel = max(1, nemo_parallel_config)
                group_count = min(requested_parallel, len(nemo_entries))
                group_size = max(1, math.ceil(len(nemo_entries) / group_count))
                if group_count > 1:
                    print(
                        f"[{base_label}] partitioning {len(nemo_entries)} file(s) into "
                        f"{group_count} group(s) with up to {group_size} file(s) each"
                    )

                for index in range(group_count):
                    start = index * group_size
                    end = start + group_size
                    group_entries = nemo_entries[start:end]
                    if not group_entries:
                        continue

                    staged_paths = [str(entry.staged) for entry in group_entries]

                    if group_count > 1:
                        process_label = f"{base_label}-p{index + 1}"
                        parallel_group = base_label
                    else:
                        process_label = base_label
                        parallel_group = None

                    nemo_argv = ["--output-dir", str(workflow_root)]
                    if cfg.model_name:
                        nemo_argv.extend(["--model", str(cfg.model_name)])
                    if cfg.vad_model:
                        nemo_argv.extend(["--vad-model", str(cfg.vad_model)])
                    if cfg.decode_strategy:
                        nemo_argv.extend(["--decode-strategy", str(cfg.decode_strategy)])
                    nemo_argv.extend(
                        [
                            "--source-lang",
                            cfg.language,
                            "--target-lang",
                            cfg.language,
                        ]
                    )

                    beam_size = config.nemo_beam_size
                    softmax_temperature = config.nemo_softmax_temperature
                    beam_length_penalty = config.nemo_beam_length_penalty
                    beam_max_generation_delta = config.nemo_beam_max_generation_delta
                    if cfg.decode_strategy == "beam":
                        nemo_argv.extend(["--beam-size", str(beam_size)])
                        nemo_argv.extend(["--softmax-temperature", str(softmax_temperature)])
                        if beam_length_penalty is not None:
                            nemo_argv.extend(["--beam-length-penalty", str(beam_length_penalty)])
                        if beam_max_generation_delta is not None:
                            nemo_argv.extend(
                                ["--beam-max-generation-delta", str(beam_max_generation_delta)]
                            )

                    nemo_argv.extend(extra_args)
                    nemo_argv.append("--audio")
                    nemo_argv.extend(staged_paths)

                    nemo_extra_env = {
                        "PYTORCH_ALLOC_CONF": "expandable_segments:True",
                        "BESEDY_NEMO_VAD_NUM_WORKERS": os.getenv(
                            "BESEDY_NEMO_VAD_NUM_WORKERS", "0"
                        ),
                        **forward_host_env(
                            "NEMO_LOG_TEXT_NO_WORDS",
                            "NEMO_LOG_TEXT_NO_WORDS_LIMIT",
                        ),
                    }

                    process = build_python_backend_process(
                        backend_id="nemo",
                        display_name="NeMo",
                        script_path=script_path,
                        script_args=nemo_argv,
                        docker_service="nemo",
                        extra_env=nemo_extra_env,
                        input_paths=[str(entry.staged) for entry in group_entries],
                        output_paths=_as_path_args(workflow_root),
                        model_paths=_local_model_paths(
                            cfg.model_name,
                            cfg.vad_model,
                            cfg.align_model,
                        ),
                        docker_gpus="all",
                    )
                    workflows.append(
                        _workflow_from_backend_process(
                            label=process_label,
                            process=process,
                            parallel_group=parallel_group,
                        )
                    )

            if has_align:
                ready, message = check_python_backend_runtime_ready(
                    backend_id="whisperx",
                    display_name="WhisperX",
                    docker_service="whisperx",
                )
                if not ready:
                    print(
                        f"Skipping canary-nemo alignment; {message}",
                        file=sys.stderr,
                    )
                else:
                    align_entries = [
                        entry
                        for entry in prepared
                        if hash_component_from_sha(entry.sha256) in job.align_hashes
                    ]
                    segments_paths = [
                        output_root
                        / cfg.workflow_label
                        / output_component
                        / hash_component
                        / "nemo_beam_segments.json"
                        for hash_component in sorted(job.align_hashes)
                    ]
                    align_argv = [
                        "--segments",
                        *[str(path) for path in segments_paths],
                        "--backend",
                        cfg.workflow_id,
                        "--model",
                        cfg.model_name,
                        "--language",
                        cfg.language,
                    ]
                    if cfg.align_model:
                        align_argv.extend(["--align-model", cfg.align_model])
                    if not config.overwrite:
                        align_argv.append("--skip-existing")

                    align_input_paths = [entry.staged for entry in align_entries]
                    align_input_paths.extend(
                        _metadata_audio_paths(
                            *segments_paths,
                            *(path.parent / "transcript.json" for path in segments_paths),
                        )
                    )

                    process = build_python_backend_process(
                        backend_id="whisperx",
                        display_name="WhisperX",
                        script_path=NEMO_WHISPERX_ALIGN_SCRIPT_PATH,
                        script_args=align_argv,
                        docker_service="whisperx",
                        extra_env={
                            "BESEDY_WHISPERX_CLI": "whisperx",
                            **forward_host_env("HF_TOKEN", "HUGGINGFACE_TOKEN"),
                        },
                        input_paths=[str(path) for path in align_input_paths],
                        output_paths=[str(path.parent) for path in segments_paths],
                        model_paths=_local_model_paths(cfg.align_model),
                        docker_gpus="all",
                    )
                    workflows.append(
                        _workflow_from_backend_process(
                            label=f"{base_label}-align",
                            process=process,
                        )
                    )

    if faster_jobs:
        for job in faster_jobs:
            cfg = job.config
            faster_entries = [
                entry for entry in prepared if hash_component_from_sha(entry.sha256) in job.hashes
            ]
            if not faster_entries:
                continue

            output_component = cfg.output_component(sanitize_model_identifier)
            faster_label = f"{cfg.workflow_label}-{output_component}"

            workflow_root = output_root / cfg.workflow_label
            workflow_root.mkdir(parents=True, exist_ok=True)

            faster_argv = ["--output-dir", str(workflow_root)]
            faster_argv.extend(["--model", str(cfg.model_name)])
            faster_argv.extend(["--language", cfg.language])
            if cfg.vad_model:
                faster_argv.extend(["--vad-model", str(cfg.vad_model)])
            if config.cpu:
                faster_argv.extend(["--device", "cpu", "--compute-type", "int8"])
            faster_argv.append("--audio")
            faster_argv.extend(str(entry.staged) for entry in faster_entries)

            faster_extra_env = forward_host_env("HF_TOKEN", "HUGGINGFACE_TOKEN")

            process = build_python_backend_process(
                backend_id="faster-whisper",
                display_name="faster-whisper",
                script_path=FASTER_WHISPER_SCRIPT_PATH,
                script_args=faster_argv,
                docker_service="faster-whisper",
                extra_env=faster_extra_env or None,
                input_paths=[str(entry.staged) for entry in faster_entries],
                output_paths=_as_path_args(workflow_root),
                model_paths=_local_model_paths(cfg.model_name, cfg.vad_model),
                docker_gpus=None if config.cpu else "all",
            )
            workflows.append(
                _workflow_from_backend_process(
                    label=faster_label,
                    process=process,
                )
            )

    if qwen_jobs:
        for job in qwen_jobs:
            cfg = job.config
            qwen_entries = [
                entry for entry in prepared if hash_component_from_sha(entry.sha256) in job.hashes
            ]
            if not qwen_entries:
                continue

            output_component = cfg.output_component(sanitize_model_identifier)
            qwen_label = f"{cfg.workflow_label}-{output_component}"

            workflow_root = output_root / cfg.workflow_label
            workflow_root.mkdir(parents=True, exist_ok=True)

            qwen_argv = ["--output-dir", str(workflow_root), "--model", str(cfg.model_name)]
            qwen_argv.extend(["--language", cfg.language])
            if cfg.vad_model:
                qwen_argv.extend(["--vad-model", str(cfg.vad_model)])
            if cfg.align_model:
                qwen_argv.extend(["--align-model", str(cfg.align_model)])
            qwen_argv.append("--audio")
            qwen_argv.extend(str(entry.staged) for entry in qwen_entries)

            qwen_extra_env = {
                "PYTORCH_ALLOC_CONF": "expandable_segments:True",
                "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
                **forward_host_env("HF_TOKEN", "HUGGINGFACE_TOKEN"),
            }

            process = build_python_backend_process(
                backend_id="qwen3-asr",
                display_name="qwen3-asr",
                script_path=QWEN3_ASR_SCRIPT_PATH,
                script_args=qwen_argv,
                docker_service="qwen3-asr",
                extra_env=qwen_extra_env,
                input_paths=[str(entry.staged) for entry in qwen_entries],
                output_paths=_as_path_args(workflow_root),
                model_paths=_local_model_paths(
                    cfg.model_name,
                    cfg.vad_model,
                    cfg.align_model,
                ),
                docker_gpus="all",
            )
            workflows.append(
                _workflow_from_backend_process(
                    label=qwen_label,
                    process=process,
                )
            )

    whisperx_available = False
    if whisperx_jobs:
        whisperx_available, whisperx_unavailable_reason = check_python_backend_runtime_ready(
            backend_id="whisperx",
            display_name="WhisperX",
            docker_service="whisperx",
        )
    else:
        whisperx_unavailable_reason = None

    if whisperx_jobs and whisperx_available:
        for job in whisperx_jobs:
            cfg = job.config
            whisperx_entries = [
                entry for entry in prepared if hash_component_from_sha(entry.sha256) in job.hashes
            ]
            if not whisperx_entries:
                continue

            output_component = cfg.output_component(sanitize_model_identifier)
            whisperx_label = f"{cfg.workflow_label}-{output_component}"
            whisperx_output_root = output_root / cfg.workflow_label
            whisperx_output_root.mkdir(parents=True, exist_ok=True)

            staged_paths = [str(entry.staged) for entry in whisperx_entries]
            whisperx_argv: list[str] = [
                "--output-dir",
                str(whisperx_output_root),
                "--model",
                str(cfg.model_name),
                "--language",
                cfg.language,
            ]
            if cfg.vad_model:
                whisperx_argv.extend(["--vad-model", str(cfg.vad_model)])
            if cfg.align_model:
                whisperx_argv.extend(["--align-model", str(cfg.align_model)])
            whisperx_argv.extend(["--audio", *staged_paths])

            print(
                f"[{cfg.workflow_label}] launching transcribe_whisperx.py for "
                f"{len(whisperx_entries)} file(s)"
            )
            whisperx_extra_env = {
                "BESEDY_WHISPERX_CLI": "whisperx",
                **forward_host_env("HF_TOKEN", "HUGGINGFACE_TOKEN"),
            }

            process = build_python_backend_process(
                backend_id="whisperx",
                display_name="WhisperX",
                script_path=WHISPERX_SCRIPT_PATH,
                script_args=whisperx_argv,
                docker_service="whisperx",
                extra_env=whisperx_extra_env or None,
                input_paths=[str(entry.staged) for entry in whisperx_entries],
                output_paths=_as_path_args(whisperx_output_root),
                model_paths=_local_model_paths(
                    cfg.model_name,
                    cfg.vad_model,
                    cfg.align_model,
                ),
                docker_gpus="all",
            )
            workflows.append(
                _workflow_from_backend_process(
                    label=whisperx_label,
                    process=process,
                )
            )
    elif whisperx_jobs and not whisperx_available:
        print(
            f"Skipping whisperx workflow; {whisperx_unavailable_reason}",
            file=sys.stderr,
        )

    run_pyannote_diarization = config.enable_pyannote_diarization

    if run_pyannote_diarization:
        pyannote_config = get_workflow_config("pyannote")
        base_label = pyannote_config.workflow_label
        pyannote_entries = [
            entry
            for entry in prepared
            if hash_component_from_sha(entry.sha256) in hashes_for_pyannote_diarization
        ]
        if pyannote_entries:
            workflow_root = output_root / base_label
            workflow_root.mkdir(parents=True, exist_ok=True)

            pyannote_parallel_config = (
                config.pyannote_parallel
                if config.pyannote_parallel is not None
                else calculate_parallel_instances(pyannote_config)
            )
            requested_parallel = max(1, pyannote_parallel_config)
            group_count = min(requested_parallel, len(pyannote_entries))
            group_size = max(1, math.ceil(len(pyannote_entries) / group_count))

            if group_count > 1:
                print(
                    f"[{base_label}] partitioning {len(pyannote_entries)} file(s) into "
                    f"{group_count} group(s) with up to {group_size} file(s) each"
                )

            for index in range(group_count):
                start = index * group_size
                end = start + group_size
                group_entries = pyannote_entries[start:end]
                if not group_entries:
                    continue

                staged_paths = [str(entry.staged) for entry in group_entries]

                if group_count > 1:
                    process_label = f"{base_label}-p{index + 1}"
                    parallel_group = base_label
                else:
                    process_label = base_label
                    parallel_group = None

                pyannote_argv = ["--output-dir", str(workflow_root)]

                min_speakers = config.pyannote_min_speakers
                max_speakers = config.pyannote_max_speakers
                clustering_threshold = config.pyannote_clustering_threshold

                if min_speakers is not None:
                    pyannote_argv.extend(["--min-speakers", str(min_speakers)])
                if max_speakers is not None:
                    pyannote_argv.extend(["--max-speakers", str(max_speakers)])
                if clustering_threshold is not None:
                    pyannote_argv.extend(["--clustering-threshold", str(clustering_threshold)])

                pyannote_argv.append("--audio")
                pyannote_argv.extend(staged_paths)
                pyannote_extra_env = {
                    "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD": "1",
                    **forward_host_env("HF_TOKEN", "HUGGINGFACE_TOKEN"),
                }

                process = build_python_backend_process(
                    backend_id="pyannote",
                    display_name="pyannote-audio",
                    script_path=PYANNOTE_DIARIZATION_SCRIPT_PATH,
                    script_args=pyannote_argv,
                    docker_service="pyannote",
                    extra_env=pyannote_extra_env or None,
                    input_paths=[str(entry.staged) for entry in group_entries],
                    output_paths=_as_path_args(workflow_root),
                    docker_gpus=None if config.cpu else "all",
                )
                workflows.append(
                    _workflow_from_backend_process(
                        label=process_label,
                        process=process,
                        parallel_group=parallel_group,
                    )
                )
        elif hashes_for_pyannote_diarization:
            print(f"Skipping {base_label}; no staged entries remaining after filtering.")
    elif hashes_for_pyannote_diarization:
        print(
            f"Skipping {get_workflow_config('pyannote').workflow_label}; workflow disabled via --workflow."
        )

    return workflows


def launch_workflows(
    workflows: Sequence[WorkflowSpec], base_env: dict[str, str]
) -> list[tuple[str, int]]:
    # Install signal handlers for graceful cleanup on SIGINT/SIGTERM
    install_signal_handlers()

    failures: list[tuple[str, int]] = []

    def run_spec(spec: WorkflowSpec) -> int | None:
        env = base_env.copy()
        if spec.extra_env:
            env.update(spec.extra_env)
        printable_cmd = _redact_printable_argv(spec.argv)
        print(f"\n>>> Launching {spec.label}\n$ {printable_cmd}")
        try:
            result = subprocess.run(spec.argv, env=env, cwd=str(PROJECT_ROOT), check=False)
        except OSError as exc:
            print(f"Failed to launch {spec.label}: {exc}", file=sys.stderr)
            failures.append((spec.label, -1))
            return None
        return_code = (
            result.returncode if isinstance(result, subprocess.CompletedProcess) else result
        )
        if return_code != 0:
            print(f"{spec.label} exited with code {return_code}", file=sys.stderr)
            failures.append((spec.label, return_code))
        else:
            print(f"{spec.label} completed successfully.")
        return return_code

    processed_parallel_groups: set[str] = set()

    for spec in workflows:
        if spec.parallel_group:
            group_id = spec.parallel_group
            if group_id in processed_parallel_groups:
                continue

            group_specs = [
                candidate for candidate in workflows if candidate.parallel_group == group_id
            ]
            processes: list[tuple[str, subprocess.Popen]] = []
            for group_spec in group_specs:
                env = base_env.copy()
                if group_spec.extra_env:
                    env.update(group_spec.extra_env)
                printable_cmd = _redact_printable_argv(group_spec.argv)
                print(
                    f"\n>>> Launching {group_spec.label} (parallel group '{group_id}')\n$ {printable_cmd}"
                )
                try:
                    proc = subprocess.Popen(group_spec.argv, env=env, cwd=str(PROJECT_ROOT))
                    register_process(proc)
                except OSError as exc:
                    print(f"Failed to launch {group_spec.label}: {exc}", file=sys.stderr)
                    failures.append((group_spec.label, -1))
                    continue
                processes.append((group_spec.label, proc))

            for label, proc in processes:
                ret_code = proc.wait()
                unregister_process(proc)
                if ret_code != 0:
                    print(f"{label} exited with code {ret_code}", file=sys.stderr)
                    failures.append((label, ret_code))
                else:
                    print(f"{label} completed successfully.")

            processed_parallel_groups.add(group_id)
        else:
            run_spec(spec)

    return failures
