"""Regression tests for besedy.lib.nemo package exports."""

from __future__ import annotations

import importlib
import sys
import types

import pytest


def _install_fake_nemo_modules(monkeypatch: pytest.MonkeyPatch) -> None:
    """Provide a minimal NeMo module tree so package imports can resolve."""

    def _package(name: str) -> types.ModuleType:
        module = types.ModuleType(name)
        module.__path__ = []  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, name, module)
        return module

    nemo = _package("nemo")
    collections = _package("nemo.collections")
    asr = _package("nemo.collections.asr")
    models = _package("nemo.collections.asr.models")
    parts = _package("nemo.collections.asr.parts")
    utils = _package("nemo.collections.asr.parts.utils")

    vad_utils = types.ModuleType("nemo.collections.asr.parts.utils.vad_utils")
    vad_utils.generate_overlap_vad_seq = lambda **kwargs: kwargs.get("out_dir") or ""  # type: ignore[attr-defined]
    vad_utils.generate_vad_segment_table = lambda **kwargs: kwargs.get("out_dir") or ""  # type: ignore[attr-defined]
    vad_utils.get_vad_stream_status = lambda keys: ["single"] * len(keys)  # type: ignore[attr-defined]
    vad_utils.prepare_manifest = lambda cfg: cfg["input"]  # type: ignore[attr-defined]
    vad_utils.write_vad_infer_manifest = lambda file, args: []  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "nemo.collections.asr.parts.utils.vad_utils", vad_utils)

    aed_models = types.ModuleType("nemo.collections.asr.models.aed_multitask_models")

    class ASRModel: ...

    class EncDecFrameClassificationModel: ...

    class MultiTaskTranscriptionConfig: ...

    models.ASRModel = ASRModel  # type: ignore[attr-defined]
    models.EncDecFrameClassificationModel = EncDecFrameClassificationModel  # type: ignore[attr-defined]
    aed_models.MultiTaskTranscriptionConfig = MultiTaskTranscriptionConfig  # type: ignore[attr-defined]

    monkeypatch.setitem(
        sys.modules,
        "nemo.collections.asr.models.aed_multitask_models",
        aed_models,
    )

    nemo.collections = collections  # type: ignore[attr-defined]
    collections.asr = asr  # type: ignore[attr-defined]
    asr.models = models  # type: ignore[attr-defined]
    asr.parts = parts  # type: ignore[attr-defined]
    models.aed_multitask_models = aed_models  # type: ignore[attr-defined]
    parts.utils = utils  # type: ignore[attr-defined]
    utils.vad_utils = vad_utils  # type: ignore[attr-defined]


@pytest.mark.optional_dependency
def test_nemo_package_reexports_vad_debug_helpers(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("numpy")
    pytest.importorskip("omegaconf")
    pytest.importorskip("soundfile")
    pytest.importorskip("torch")
    pytest.importorskip("tqdm")

    _install_fake_nemo_modules(monkeypatch)
    sys.modules.pop("besedy.lib.nemo", None)

    debug = importlib.import_module("besedy.lib.nemo.vad_debug")
    nemo_pkg = importlib.import_module("besedy.lib.nemo")

    assert nemo_pkg.build_chunk_metadata is debug.build_chunk_metadata
    assert nemo_pkg.build_postprocessing_params is debug.build_postprocessing_params
    assert nemo_pkg.persist_vad_debug_artifacts is debug.persist_vad_debug_artifacts
