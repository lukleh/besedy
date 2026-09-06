from __future__ import annotations

import sys
import types
from typing import Any

import pytest

from besedy.lib import rag_pylate


def _original() -> tuple[Any, list[tuple[tuple[Any, ...], dict[str, Any]]]]:
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def _resolve(*args: Any, **kwargs: Any) -> bool:
        calls.append((args, kwargs))
        return False

    return _resolve, calls


def test_auto_trust_approves_nested_repo_passed_positionally() -> None:
    original, calls = _original()
    auto_trust = rag_pylate._make_remote_code_auto_trust(original)

    # transformers' auto classes pass ``upstream_repo`` as the fifth positional
    # argument, which the signature names ``error_message``.
    resolved = auto_trust(
        None,
        "jinaai/jina-colbert-v2",
        False,
        True,
        "jinaai/xlm-roberta-flash-implementation",
    )

    assert resolved is True
    assert calls == []


def test_auto_trust_approves_nested_repo_passed_by_keyword() -> None:
    original, calls = _original()
    auto_trust = rag_pylate._make_remote_code_auto_trust(original)

    resolved = auto_trust(
        None,
        "jinaai/jina-colbert-v2",
        False,
        True,
        upstream_repo="jinaai/xlm-roberta-flash-implementation",
    )

    assert resolved is True
    assert calls == []


@pytest.mark.parametrize(
    ("args", "kwargs"),
    [
        # Explicit opt-out stays an opt-out.
        ((False, "jinaai/jina-colbert-v2", False, True, "jinaai/other-repo"), {}),
        # A local implementation exists: upstream prefers it over remote code.
        ((None, "jinaai/jina-colbert-v2", True, True, "jinaai/other-repo"), {}),
        # Top-level repo with no nested reference.
        ((None, "some/model", False, True, None), {}),
        # Custom generation code passes prose as ``error_message``.
        (
            (None, "some/model"),
            {
                "has_local_code": False,
                "has_remote_code": True,
                "error_message": "The repository some/model contains custom generation code.",
            },
        ),
    ],
)
def test_auto_trust_delegates_outside_the_nested_prompt(
    args: tuple[Any, ...], kwargs: dict[str, Any]
) -> None:
    original, calls = _original()
    auto_trust = rag_pylate._make_remote_code_auto_trust(original)

    resolved = auto_trust(*args, **kwargs)

    assert resolved is False
    assert calls == [(args, kwargs)]


def test_rebind_reaches_modules_that_already_imported_the_resolver() -> None:
    original, _ = _original()
    replacement, _ = _original()

    defining = types.ModuleType("besedy_fake_dynamic_module_utils")
    setattr(defining, "resolve_trust_remote_code", original)
    consumer = types.ModuleType("besedy_fake_tokenization_auto")
    setattr(consumer, "resolve_trust_remote_code", original)
    unrelated = types.ModuleType("besedy_fake_unrelated")
    setattr(unrelated, "resolve_trust_remote_code", replacement)

    sys.modules[defining.__name__] = defining
    sys.modules[consumer.__name__] = consumer
    sys.modules[unrelated.__name__] = unrelated
    try:
        rag_pylate._rebind_remote_code_resolver(original, replacement)
    finally:
        for module in (defining, consumer, unrelated):
            del sys.modules[module.__name__]

    assert getattr(defining, "resolve_trust_remote_code") is replacement
    assert getattr(consumer, "resolve_trust_remote_code") is replacement
    assert getattr(unrelated, "resolve_trust_remote_code") is replacement


def test_rebind_does_not_trigger_lazy_module_attribute_access() -> None:
    original, _ = _original()
    replacement, _ = _original()

    class _LazyModule(types.ModuleType):
        def __getattr__(self, name: str) -> Any:
            raise AssertionError(f"lazy import triggered for {name!r}")

    lazy = _LazyModule("besedy_fake_lazy_module")
    sys.modules[lazy.__name__] = lazy
    try:
        rag_pylate._rebind_remote_code_resolver(original, replacement)
    finally:
        del sys.modules[lazy.__name__]


def test_ensure_remote_code_auto_trust_patches_once(monkeypatch: pytest.MonkeyPatch) -> None:
    original, calls = _original()
    dynamic_module_utils = types.ModuleType("transformers.dynamic_module_utils")
    setattr(dynamic_module_utils, "resolve_trust_remote_code", original)
    transformers = types.ModuleType("transformers")
    setattr(transformers, "dynamic_module_utils", dynamic_module_utils)
    consumer = types.ModuleType("besedy_fake_consumer")
    setattr(consumer, "resolve_trust_remote_code", original)

    monkeypatch.setitem(sys.modules, "transformers", transformers)
    monkeypatch.setitem(sys.modules, "transformers.dynamic_module_utils", dynamic_module_utils)
    monkeypatch.setitem(sys.modules, consumer.__name__, consumer)
    monkeypatch.setattr(rag_pylate, "_remote_code_auto_trust_applied", False)

    rag_pylate.ensure_remote_code_auto_trust()
    patched = getattr(dynamic_module_utils, "resolve_trust_remote_code")

    assert patched is not original
    assert getattr(consumer, "resolve_trust_remote_code") is patched

    # Re-entry is a no-op: it must not wrap the already-installed patch again.
    rag_pylate.ensure_remote_code_auto_trust()
    assert getattr(dynamic_module_utils, "resolve_trust_remote_code") is patched

    assert patched(None, "jinaai/jina-colbert-v2", False, True, "jinaai/nested-repo") is True
    assert calls == []
