"""rlmbenchy runtime/profile helpers for the Prefect deep-search adapter."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rlmbenchy.rlm import (
    DockerReplRuntime,
    LMProfile,
    LocalProcessReplRuntime,
    RLMRunConfig,
    build_lm,
    load_lm_profile,
    resolve_lm_profile_path,
    resolve_model_api_key,
    validate_supported_parameters_for_openrouter,
)

from .json_types import JsonDict, coerce_json_dict


@dataclass(frozen=True)
class ProfileResolution:
    ref: str
    path: Path
    profile: LMProfile


@dataclass(frozen=True)
class LMResolution:
    main: ProfileResolution
    sub: ProfileResolution


def resolve_lm_profiles(
    *,
    retrieval: object,
) -> LMResolution:
    main_ref = _resolve_profile_ref(
        retrieval=retrieval,
        retrieval_keys=("lm_profile", "lmProfile"),
        env_keys=("RLMBENCHY_LM_PROFILE",),
        label="main LM profile",
    )
    sub_ref = _resolve_profile_ref(
        retrieval=retrieval,
        retrieval_keys=("sub_lm_profile", "subLmProfile"),
        env_keys=("RLMBENCHY_SUB_LM_PROFILE",),
        label="sub LM profile",
    )
    return LMResolution(
        main=_load_profile(ref=main_ref),
        sub=_load_profile(ref=sub_ref),
    )


def build_rlm_run_config_from_profile(
    *,
    profile: LMProfile,
    adapter_mode: str,
    seed: int,
) -> RLMRunConfig:
    request_params: dict[str, Any] = {**dict(profile.request_kwargs), "seed": int(seed)}
    validate_supported_parameters_for_openrouter(
        api_base=profile.api_base,
        model=profile.model,
        supported_parameter_mode=profile.supported_parameter_mode,
        ignore_unsupported_parameters=profile.ignore_unsupported_parameters,
        request_params=request_params,
    )
    api_key = resolve_model_api_key(
        api_base=profile.api_base,
        api_key=profile.api_key,
        api_key_env=profile.api_key_env,
        api_key_override=None,
    )
    return RLMRunConfig(
        api_base=profile.api_base,
        model=profile.model,
        api_key=api_key,
        adapter_mode=adapter_mode,
        request_kwargs=request_params,
        lm_transport=profile.lm_transport,
    )


def build_sub_lm_from_profile(
    *,
    profile: LMProfile | None,
    seed: int,
) -> Any | None:
    if profile is None:
        return None
    request_params: dict[str, Any] = {**dict(profile.request_kwargs), "seed": int(seed)}
    validate_supported_parameters_for_openrouter(
        api_base=profile.api_base,
        model=profile.model,
        supported_parameter_mode=profile.supported_parameter_mode,
        ignore_unsupported_parameters=profile.ignore_unsupported_parameters,
        request_params=request_params,
    )
    api_key = resolve_model_api_key(
        api_base=profile.api_base,
        api_key=profile.api_key,
        api_key_env=profile.api_key_env,
        api_key_override=None,
    )
    kwargs: dict[str, Any] = {
        "api_base": profile.api_base,
        "model": profile.model,
        "api_key": api_key,
        "request_kwargs": request_params,
    }
    if profile.lm_transport != "auto":
        kwargs["lm_transport"] = profile.lm_transport
    return build_lm(**kwargs)


def build_repl_runtime(*, repl_backend: str) -> Any:
    runtime_cls = LocalProcessReplRuntime if repl_backend == "local" else DockerReplRuntime
    return runtime_cls()


def resolve_repl_backend() -> str:
    return str(os.getenv("RLMBENCHY_REPL_BACKEND", "local")).strip().lower() or "local"


def resolve_adapter_mode(*, retrieval: object, default_mode: str) -> str:
    retrieval_payload = coerce_json_dict(retrieval)
    for key in ("adapter_mode", "adapterMode"):
        value = retrieval_payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return str(os.getenv("RLMBENCHY_ADAPTER_MODE", default_mode)).strip() or default_mode


def resolve_seed(*, default_seed: int) -> int:
    raw = os.getenv("RLMBENCHY_SEED", "").strip()
    if not raw:
        return default_seed
    try:
        return int(raw)
    except ValueError:
        return default_seed


def resolve_log_dir(*, output_root_dir: Path, flow_run_id: str) -> Path:
    return output_root_dir / flow_run_id / "rlmbenchy"


def build_rlm_context(
    *,
    query: str,
    initial_retrieval: JsonDict,
    citation_expansions: list[JsonDict],
) -> str:
    hits = _list_of_objects(initial_retrieval.get("hits"))
    lines = [
        "# Besedy Deep Search Context",
        "",
        f"Query: {query}",
        "",
        "## Initial Retrieval",
        "",
    ]
    if not hits:
        lines.append("No initial hits were returned.")
        lines.append("")
    else:
        for index, item in enumerate(hits, start=1):
            lines.extend(_format_hit_context(index=index, item=item))

    lines.extend(["## Expanded Context", ""])
    if not citation_expansions:
        lines.extend(["No citation expansions were returned.", ""])
    else:
        for index, expansion in enumerate(citation_expansions, start=1):
            lines.extend(_format_citation_context(index=index, expansion=expansion))
    return "\n".join(lines).rstrip()


def _resolve_profile_ref(
    *,
    retrieval: object,
    retrieval_keys: tuple[str, ...],
    env_keys: tuple[str, ...],
    label: str,
) -> str:
    retrieval_payload = coerce_json_dict(retrieval)
    for key in retrieval_keys:
        value = retrieval_payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for env_key in env_keys:
        value = os.getenv(env_key, "").strip()
        if value:
            return value
    raise ValueError(f"Missing {label}. Set retrieval.{retrieval_keys[0]} or {env_keys[0]}.")


def _load_profile(*, ref: str) -> ProfileResolution:
    candidate = Path(ref).expanduser()
    if candidate.exists():
        path = candidate.resolve()
    else:
        path = resolve_lm_profile_path(ref)
    profile = load_lm_profile(path)
    return ProfileResolution(ref=ref, path=Path(path), profile=profile)


def _format_hit_context(*, index: int, item: JsonDict) -> list[str]:
    lines = [
        f"### Hit {index}",
        f"- chunkId: {_string_or_none(item.get('chunkId')) or 'unknown'}",
        f"- audioHash: {_string_or_none(item.get('audioHash')) or 'unknown'}",
    ]
    start = item.get("startSec")
    end = item.get("endSec")
    if start is not None or end is not None:
        lines.append(
            f"- window: {_string_or_none(start) or '?'}s -> {_string_or_none(end) or '?'}s"
        )
    score = item.get("score")
    if score is not None:
        lines.append(f"- score: {_string_or_none(score) or '?'}")
    text = _string_or_none(item.get("text"))
    if text:
        lines.extend(["", text])
    lines.append("")
    return lines


def _format_citation_context(*, index: int, expansion: JsonDict) -> list[str]:
    chunk = _as_object(expansion.get("chunk"))
    lines = [
        f"### Expansion {index}",
        f"- chunkId: {_string_or_none(chunk.get('chunkId')) or 'unknown'}",
        f"- audioHash: {_string_or_none(chunk.get('audioHash')) or 'unknown'}",
    ]
    context_text = _string_or_none(expansion.get("contextText"))
    if context_text:
        lines.extend(["", context_text])
    lines.append("")
    return lines


def _as_object(value: object) -> JsonDict:
    return coerce_json_dict(value)


def _list_of_objects(value: object) -> list[JsonDict]:
    if isinstance(value, list):
        return [coerce_json_dict(item) for item in value]
    return []


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
