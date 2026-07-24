from __future__ import annotations

import os
import sys
import types

import pytest

pytestmark = pytest.mark.optional_dependency
torch = pytest.importorskip("torch", reason="requires the optional ML extra")

from besedy.lib.speakers import embeddings as embeddings_module  # noqa: E402


def _install_fake_pyannote(monkeypatch) -> None:
    pyannote_pkg = types.ModuleType("pyannote")
    pyannote_pkg.__path__ = []  # type: ignore[attr-defined]
    audio_mod = types.ModuleType("pyannote.audio")

    class FakeModel:
        @staticmethod
        def from_pretrained(model_id: str, token: str | None = None):
            return {"model_id": model_id, "token": token}

    class FakeInference:
        def __init__(self, model, *, device, window):
            self.model = model
            self.device = device
            self.window = window

    audio_mod.Model = FakeModel  # type: ignore[attr-defined]
    audio_mod.Inference = FakeInference  # type: ignore[attr-defined]
    pyannote_pkg.audio = audio_mod  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "pyannote", pyannote_pkg)
    monkeypatch.setitem(sys.modules, "pyannote.audio", audio_mod)


def test_load_embedding_model_sets_checkpoint_load_override(monkeypatch) -> None:
    _install_fake_pyannote(monkeypatch)
    monkeypatch.setattr(embeddings_module, "_require_pyannote", lambda: None)
    monkeypatch.delenv("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", raising=False)

    inference, model_name = embeddings_module.load_embedding_model(
        "secret-token",
        torch.device("cpu"),
        "pyannote",
    )

    assert os.environ["TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"] == "1"
    assert model_name == "pyannote-embedding"
    assert inference.model == {"model_id": "pyannote/embedding", "token": "secret-token"}
    assert inference.device == torch.device("cpu")
    assert inference.window == "whole"
