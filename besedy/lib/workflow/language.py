"""Shared language policy for transcription workflows.

Single source of truth for how Besedy treats transcription languages:

- Config values are ISO 639 codes (e.g. "cs") or the "auto" sentinel; the
  config loader normalizes and validates them via
  :func:`normalize_config_language`.
- Per-workflow rules (which backends support automatic detection, which
  aligner combinations are safe) live in :func:`validate_workflow_language`
  so the config loader and the workflow CLIs enforce identical rules.
- Backends that expect a different language representation translate at
  their inference boundary (:func:`qwen_language_name` for Qwen3-ASR);
  configured values and output paths stay uniform ISO codes.

This module must stay free of besedy imports so ``besedy.config.settings``
can use it without an import cycle.
"""

from __future__ import annotations

from collections.abc import Callable

AUTO_LANGUAGE = "auto"

# Every workflow transcribed Czech before language became configurable, so a
# missing `language` key keeps that behavior (and the legacy output paths).
LEGACY_DEFAULT_LANGUAGE = "cs"

# Canary prompts require explicit source/target languages.
_WORKFLOWS_WITHOUT_LANGUAGE_DETECTION = frozenset({"canary-nemo", "canary-nemo-beam"})

# Qwen3-ASR validates languages against full names ("Czech", not "cs").
# Keep in sync with SUPPORTED_LANGUAGES of the qwen-asr version pinned in
# backends/qwen3-asr/Dockerfile.
QWEN_LANGUAGE_NAMES_BY_CODE: dict[str, str] = {
    "ar": "Arabic",
    "cs": "Czech",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "fa": "Persian",
    "fi": "Finnish",
    "fil": "Filipino",
    "fr": "French",
    "hi": "Hindi",
    "hu": "Hungarian",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "mk": "Macedonian",
    "ms": "Malay",
    "nl": "Dutch",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sv": "Swedish",
    "th": "Thai",
    "tr": "Turkish",
    "vi": "Vietnamese",
    "yue": "Cantonese",
    "zh": "Chinese",
}
_QWEN_CODES_BY_NAME = {name.casefold(): code for code, name in QWEN_LANGUAGE_NAMES_BY_CODE.items()}


def resolve_inference_language(language: str | None) -> str | None:
    """Map the configured ``auto`` sentinel to the value ASR APIs expect."""
    if language is None:
        return None
    value = language.strip()
    if not value or value.casefold() == AUTO_LANGUAGE:
        return None
    return value


def resolve_language_setting(cli_value: str | None, configured: str) -> str:
    """Resolve and canonicalize the language setting from a CLI override and config."""
    value = cli_value if cli_value is not None else configured
    return value.strip().casefold() or AUTO_LANGUAGE


def language_output_component(
    language: str,
    sanitize_fn: Callable[[str], str],
) -> str | None:
    """Return a path component when language differs from the legacy Czech default."""
    normalized = language.strip().casefold()
    if normalized == LEGACY_DEFAULT_LANGUAGE:
        return None
    return f"lang-{sanitize_fn(normalized)}"


def translation_language_setting(source_language: str, target_language: str) -> str:
    """Return the path-identity language for a source/target language pair.

    Translation runs (source != target) must not share output paths with
    native transcriptions of the target language.
    """
    source = source_language.strip().casefold()
    target = target_language.strip().casefold()
    if source == target:
        return target
    return f"{source}-{target}"


def normalize_config_language(raw: object, *, context: str) -> str:
    """Validate and normalize a configured language value.

    Accepts the ``auto`` sentinel or an ISO 639 code (two or three letters).
    """
    if not isinstance(raw, str):
        raise TypeError(f"{context} language must be a string")
    language = raw.strip()
    if not language:
        raise ValueError(f"{context} language must not be empty")
    if language.casefold() == AUTO_LANGUAGE:
        return AUTO_LANGUAGE
    if len(language) in {2, 3} and language.isalpha():
        return language.lower()
    raise ValueError(
        f'{context} language {raw!r} is not supported; use "auto" or an ISO 639 code such as "cs"'
    )


def validate_workflow_language(
    workflow_id: str,
    language: str,
    align_model: str | None,
    *,
    context: str,
) -> None:
    """Enforce per-workflow language rules shared by config loading and CLIs."""
    normalized_language = language.strip().casefold()
    if (
        workflow_id in _WORKFLOWS_WITHOUT_LANGUAGE_DETECTION
        and normalized_language == AUTO_LANGUAGE
    ):
        raise ValueError(
            f"{context} {workflow_id} does not support "
            'language = "auto"; configure a concrete language code such as "cs"'
        )
    if workflow_id == "whisperx" and normalized_language == AUTO_LANGUAGE and align_model:
        raise ValueError(
            f"{context} whisperx cannot combine "
            'language = "auto" with a fixed align_model; omit align_model so '
            "WhisperX can select one after language detection, or configure a "
            "concrete language"
        )
    if workflow_id == "qwen3-asr" and normalized_language != AUTO_LANGUAGE:
        try:
            qwen_language_name(normalized_language)
        except ValueError as exc:
            raise ValueError(f"{context} {exc}") from None


def qwen_language_name(language: str | None) -> str | None:
    """Translate an ISO 639 code to the language name Qwen3-ASR expects."""
    if language is None:
        return None
    code = language.strip().casefold()
    if code in QWEN_LANGUAGE_NAMES_BY_CODE:
        return QWEN_LANGUAGE_NAMES_BY_CODE[code]
    if code in _QWEN_CODES_BY_NAME:
        return QWEN_LANGUAGE_NAMES_BY_CODE[_QWEN_CODES_BY_NAME[code]]
    supported = ", ".join(sorted(QWEN_LANGUAGE_NAMES_BY_CODE))
    raise ValueError(
        f"Qwen3-ASR does not support language {language!r}; supported ISO codes: {supported}"
    )


def qwen_language_code(name: str) -> str | None:
    """Translate a Qwen3-ASR language name back to an ISO 639 code, if known."""
    return _QWEN_CODES_BY_NAME.get(name.strip().casefold())
