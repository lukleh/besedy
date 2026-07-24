"""Tests for RagConfig parsing and resolve_default_colbert_model() precedence.

Precedence contract: RAG_COLBERT_MODEL env var > [rag].colbert_model in
besedy.toml > the built-in DEFAULT_COLBERT_MODEL. (Explicit CLI/API values win
over all of these because callers pass them directly.)
"""

from __future__ import annotations

from dataclasses import replace

from besedy.config.settings import RagConfig, get_config, set_config
from besedy.lib.rag_colbert import DEFAULT_COLBERT_MODEL, resolve_default_colbert_model


class TestRagConfig:
    def test_defaults_to_empty(self):
        assert RagConfig().colbert_model == ""

    def test_missing_section_uses_defaults(self):
        # _load_config builds this from data.get("rag", {}) when [rag] is absent.
        assert RagConfig(**{}).colbert_model == ""

    def test_parses_colbert_model(self):
        assert RagConfig(colbert_model="acme/colbert").colbert_model == "acme/colbert"


class TestResolveDefaultColbertModel:
    def test_falls_back_to_builtin_default(self, monkeypatch):
        monkeypatch.delenv("RAG_COLBERT_MODEL", raising=False)
        original = get_config()
        try:
            set_config(replace(original, rag=RagConfig(colbert_model="")))
            assert resolve_default_colbert_model() == DEFAULT_COLBERT_MODEL
        finally:
            set_config(original)

    def test_toml_value_used_when_set(self, monkeypatch):
        monkeypatch.delenv("RAG_COLBERT_MODEL", raising=False)
        original = get_config()
        try:
            set_config(replace(original, rag=RagConfig(colbert_model="toml/colbert")))
            assert resolve_default_colbert_model() == "toml/colbert"
        finally:
            set_config(original)

    def test_env_overrides_toml(self, monkeypatch):
        monkeypatch.setenv("RAG_COLBERT_MODEL", "env/colbert")
        original = get_config()
        try:
            set_config(replace(original, rag=RagConfig(colbert_model="toml/colbert")))
            assert resolve_default_colbert_model() == "env/colbert"
        finally:
            set_config(original)

    def test_blank_env_is_ignored(self, monkeypatch):
        monkeypatch.setenv("RAG_COLBERT_MODEL", "   ")
        original = get_config()
        try:
            set_config(replace(original, rag=RagConfig(colbert_model="")))
            assert resolve_default_colbert_model() == DEFAULT_COLBERT_MODEL
        finally:
            set_config(original)
