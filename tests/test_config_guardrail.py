"""Guardrail: the config-home namespace stays centralized in the canonical resolvers.

The XDG namespace (`lukleh`) and the config-home path are derived only by
``besedy/core/paths_common.py`` (``resolve_xdg_root``). Configuration discovery
delegates to that low-level resolver.

Re-deriving them anywhere else in the ``besedy`` package (e.g. hardcoding
``~/.config/lukleh/besedy``) would fork the namespace and defeat the design that
keeps the Python package's ``lukleh`` derivations confined to these two modules.
Call the resolvers instead. See AGENTS.md ("Coding Style & Naming Conventions").
"""

from __future__ import annotations

from pathlib import Path

# The only files allowed to contain the raw `lukleh` namespace literal.
CANONICAL_RESOLVERS = {
    "besedy/core/paths_common.py",
}


def test_lukleh_namespace_stays_in_canonical_resolvers() -> None:
    besedy_pkg = Path(__file__).resolve().parent.parent / "besedy"
    repo_root = besedy_pkg.parent
    assert besedy_pkg.is_dir(), f"besedy package not found at {besedy_pkg}"

    # Sanity: the canonical resolvers still hold the namespace literal, so a
    # global rename can't make this test pass vacuously by leaving nothing to find.
    for rel in sorted(CANONICAL_RESOLVERS):
        text = (repo_root / rel).read_text(encoding="utf-8")
        assert "lukleh" in text, f"expected the `lukleh` namespace literal in {rel}"

    offenders = sorted(
        py.relative_to(repo_root).as_posix()
        for py in besedy_pkg.rglob("*.py")
        if py.relative_to(repo_root).as_posix() not in CANONICAL_RESOLVERS
        and "lukleh" in py.read_text(encoding="utf-8")
    )

    assert not offenders, (
        "The `lukleh` config namespace must only be referenced by the canonical "
        "resolver (besedy/core/paths_common.py). "
        f"Found it re-derived in: {', '.join(offenders)}. "
        "Use resolve_config_path() / resolve_xdg_root() instead of hardcoding "
        "the config path."
    )
