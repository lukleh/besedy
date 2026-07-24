"""Focused tests for configurable transcription language behavior."""

from __future__ import annotations

import pytest

from besedy.config.settings import PathsConfig, _load_transcription_workflows
from besedy.lib.workflow.language import (
    normalize_config_language,
    qwen_language_code,
    qwen_language_name,
    resolve_inference_language,
    resolve_language_setting,
    translation_language_setting,
    validate_workflow_language,
)
from tests.helpers.workflows import make_workflow_entry


@pytest.mark.parametrize("workflow_id", ["faster-whisper", "whisperx", "qwen3-asr", "canary-nemo"])
def test_missing_language_key_keeps_legacy_czech_default(workflow_id: str) -> None:
    """Legacy configs (no language key) keep the historical forced-Czech behavior."""
    configs = _load_transcription_workflows(
        {"transcription_workflows": [make_workflow_entry(workflow_id)]}
    )

    assert configs[0].language == "cs"


def test_automatic_detection_is_an_explicit_opt_in() -> None:
    configs = _load_transcription_workflows(
        {"transcription_workflows": [make_workflow_entry("faster-whisper", language="AUTO")]}
    )

    assert configs[0].language == "auto"


def test_language_value_is_trimmed_and_iso_code_is_normalized() -> None:
    configs = _load_transcription_workflows(
        {"transcription_workflows": [make_workflow_entry("faster-whisper", language=" EN ")]}
    )

    assert configs[0].language == "en"


def test_language_names_are_rejected_in_favor_of_iso_codes() -> None:
    with pytest.raises(ValueError, match="ISO 639"):
        _load_transcription_workflows(
            {"transcription_workflows": [make_workflow_entry("qwen3-asr", language="Czech")]}
        )


def test_qwen_rejects_unsupported_language_during_config_load() -> None:
    with pytest.raises(ValueError, match="Qwen3-ASR does not support language 'sk'"):
        _load_transcription_workflows(
            {"transcription_workflows": [make_workflow_entry("qwen3-asr", language="sk")]}
        )


def test_canary_rejects_auto_language() -> None:
    with pytest.raises(ValueError, match="does not support.*auto"):
        _load_transcription_workflows(
            {"transcription_workflows": [make_workflow_entry("canary-nemo", language="AUTO")]}
        )


def test_canary_beam_still_requires_fixed_alignment_model() -> None:
    workflow = make_workflow_entry("canary-nemo-beam")
    workflow.pop("align_model")

    with pytest.raises(ValueError, match="missing align_model"):
        _load_transcription_workflows({"transcription_workflows": [workflow]})


def test_whisperx_auto_language_does_not_require_fixed_alignment_model() -> None:
    configs = _load_transcription_workflows(
        {"transcription_workflows": [make_workflow_entry("whisperx", language="auto")]}
    )

    assert configs[0].align_model is None


def test_whisperx_rejects_auto_language_with_fixed_alignment_model() -> None:
    with pytest.raises(ValueError, match="cannot combine.*auto.*fixed align_model"):
        _load_transcription_workflows(
            {
                "transcription_workflows": [
                    make_workflow_entry("whisperx", language="auto", align_model="czech-aligner"),
                ]
            }
        )


def test_deprecated_decoded_audio_dir_key_is_dropped_from_paths_config() -> None:
    paths = PathsConfig(transcripts_dir="t", speaker_clusters_dir="s")

    assert not hasattr(paths, "decoded_audio_dir")


class TestNormalizeConfigLanguage:
    def test_rejects_non_string(self) -> None:
        with pytest.raises(TypeError, match="must be a string"):
            normalize_config_language(7, context="ctx")

    def test_rejects_empty(self) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            normalize_config_language("  ", context="ctx")

    def test_accepts_three_letter_codes(self) -> None:
        assert normalize_config_language("FIL", context="ctx") == "fil"


class TestResolveInferenceLanguage:
    @pytest.mark.parametrize("configured", [None, "", "auto", " AUTO "])
    def test_auto_and_empty_map_to_none(self, configured: str | None) -> None:
        assert resolve_inference_language(configured) is None

    def test_concrete_codes_pass_through(self) -> None:
        assert resolve_inference_language(" cs ") == "cs"


class TestResolveLanguageSetting:
    def test_cli_value_overrides_configured(self) -> None:
        assert resolve_language_setting("de", "cs") == "de"

    def test_none_falls_back_to_configured(self) -> None:
        assert resolve_language_setting(None, "cs") == "cs"

    def test_empty_values_mean_auto(self) -> None:
        assert resolve_language_setting("", "cs") == "auto"
        assert resolve_language_setting(None, " ") == "auto"

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (" AUTO ", "auto"),
            (" CS ", "cs"),
            ("FIL", "fil"),
            (" Czech ", "czech"),
        ],
    )
    def test_cli_values_are_canonicalized(self, raw: str, expected: str) -> None:
        assert resolve_language_setting(raw, "cs") == expected


class TestValidateWorkflowLanguage:
    @pytest.mark.parametrize("language", ["AUTO", " Auto "])
    @pytest.mark.parametrize(
        ("workflow_id", "align_model"),
        [
            ("canary-nemo", None),
            ("whisperx", "czech-aligner"),
        ],
    )
    def test_auto_variants_cannot_bypass_validation(
        self,
        language: str,
        workflow_id: str,
        align_model: str | None,
    ) -> None:
        with pytest.raises(ValueError, match="auto"):
            validate_workflow_language(workflow_id, language, align_model, context="test:")


class TestQwenLanguageBoundary:
    """Config speaks ISO codes; Qwen3-ASR expects full language names."""

    def test_codes_translate_to_names(self) -> None:
        assert qwen_language_name("cs") == "Czech"
        assert qwen_language_name("EN") == "English"

    def test_names_normalize_to_canonical_names(self) -> None:
        assert qwen_language_name("czech") == "Czech"

    def test_resolved_full_name_remains_supported(self) -> None:
        setting = resolve_language_setting(" Czech ", "auto")

        assert qwen_language_name(resolve_inference_language(setting)) == "Czech"

    def test_none_passes_through_for_auto_detection(self) -> None:
        assert qwen_language_name(None) is None

    def test_unsupported_codes_fail_fast(self) -> None:
        with pytest.raises(ValueError, match="does not support language 'xx'"):
            qwen_language_name("xx")

    def test_detected_names_map_back_to_codes(self) -> None:
        assert qwen_language_code("Czech") == "cs"
        assert qwen_language_code("Klingon") is None


class TestTranslationLanguageSetting:
    """Translation runs must not share output paths with native transcriptions."""

    def test_same_language_keeps_plain_setting(self) -> None:
        assert translation_language_setting("cs", "cs") == "cs"

    def test_translation_pairs_get_combined_setting(self) -> None:
        assert translation_language_setting("de", "cs") == "de-cs"

    def test_comparison_is_case_insensitive(self) -> None:
        assert translation_language_setting("CS", "cs") == "cs"
