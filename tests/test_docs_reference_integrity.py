from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote

REPO_ROOT = Path(__file__).resolve().parents[1]
DOCS_TO_CHECK = [
    REPO_ROOT / "README.md",
    REPO_ROOT / "AGENTS.md",
    REPO_ROOT / "CLAUDE.md",
    REPO_ROOT / ".claude" / "README.md",
    REPO_ROOT / "docs" / "README.md",
    REPO_ROOT / "docs" / "adr" / "README.md",
    REPO_ROOT / "docs" / "adr" / "0001-audio-identity.md",
    REPO_ROOT / "docs" / "adr" / "0002-artifact-generations.md",
    REPO_ROOT / "docs" / "adr" / "0003-web-catalog-projection.md",
    REPO_ROOT / "docs" / "adr" / "0004-system-boundaries.md",
    REPO_ROOT / "docs" / "architecture.md",
    REPO_ROOT / "docs" / "data-model.md",
    REPO_ROOT / "docs" / "patterns.md",
    REPO_ROOT / "docs" / "rag-system.md",
    REPO_ROOT / "docs" / "backends.md",
    REPO_ROOT / "docs" / "web" / "architecture.md",
    REPO_ROOT / "docs" / "web" / "data-and-database.md",
    REPO_ROOT / "docs" / "web" / "security.md",
    REPO_ROOT / "docs" / "web" / "operations.md",
    REPO_ROOT / "besedy" / "lib" / "README.md",
    REPO_ROOT / "tests" / "README.md",
]

MARKDOWN_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
INLINE_PATH_RE = re.compile(
    r"`((?:AGENTS\.md|CLAUDE\.md|Justfile|pyproject\.toml|pytest\.ini|"
    r"(?:docs|besedy|web|scripts)/[^`\n]+))`"
)
SKIPPED_INLINE_PATHS = {
    "web/tests/e2e/fixtures/",
}
SKIPPED_INLINE_SUFFIXES = (
    ".env.dev",
    ".env.prod",
    ".env.test",
    ".env.production",
)
FORBIDDEN_TEXT_PATTERNS = {
    "removed analyze subcommand": re.compile(
        r"besedy/cli/analyze\.py\s+(stats|insight|speakers|alignment|anomalies|timing|textscan|vad-overlap)\b"
    ),
    "removed polars loader module": re.compile(r"\bpolars_loaders\b"),
    "removed load_segments helper": re.compile(r"\bload_segments\(\)"),
    "truncated persisted audio-hash directory": re.compile(
        r"hash_prefix` is typically the first 8 chars"
    ),
    "raw-file metadata changes canonical audio identity": re.compile(
        r"Any content modification \(even metadata\) produces a new hash"
    ),
}


def _resolve_link_target(doc_path: Path, target: str) -> Path | None:
    clean = target.split("#", 1)[0].strip()
    if clean.startswith(("http://", "https://", "mailto:")):
        return None
    if not clean:
        return doc_path.resolve() if target.strip().startswith("#") else None
    return (doc_path.parent / clean).resolve()


def _resolve_inline_path(candidate: str) -> Path | None:
    clean = candidate.rstrip(".,:").strip()
    if not clean or any(ch in clean for ch in "*?<>|{}$ "):
        return None
    if clean in SKIPPED_INLINE_PATHS or clean.endswith(SKIPPED_INLINE_SUFFIXES):
        return None
    return (REPO_ROOT / clean).resolve()


def _assert_path_exists(doc_path: Path, referenced_path: str, resolved: Path) -> None:
    assert resolved.exists(), (
        f"{doc_path.relative_to(REPO_ROOT)} references missing path {referenced_path!r}"
    )


def _github_heading_slug(heading: str) -> str:
    heading = re.sub(r"`([^`]*)`", r"\1", heading)
    heading = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", heading)
    heading = re.sub(r"<[^>]+>", "", heading)
    heading = re.sub(r"[^\w\s-]", "", heading.lower())
    return re.sub(r"\s", "-", heading.strip())


def _markdown_heading_anchors(text: str) -> set[str]:
    anchors: set[str] = set()
    slug_counts: dict[str, int] = {}
    in_fence = False

    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        match = re.match(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", line)
        if match is None:
            continue

        base_slug = _github_heading_slug(match.group(1))
        duplicate_index = slug_counts.get(base_slug, 0)
        slug_counts[base_slug] = duplicate_index + 1
        anchors.add(base_slug if duplicate_index == 0 else f"{base_slug}-{duplicate_index}")

    return anchors


def _assert_link_anchor_exists(doc_path: Path, target: str, resolved: Path) -> None:
    _, separator, fragment = target.partition("#")
    if not separator or not fragment or resolved.suffix.lower() != ".md":
        return

    expected_anchor = unquote(fragment).lower()
    anchors = _markdown_heading_anchors(resolved.read_text(encoding="utf-8"))
    assert expected_anchor in anchors, (
        f"{doc_path.relative_to(REPO_ROOT)} references missing anchor "
        f"{expected_anchor!r} in {resolved.relative_to(REPO_ROOT)}"
    )


def _normalized_prose(text: str) -> str:
    return " ".join(text.split())


def _active_docs_for_archive_link_check() -> list[Path]:
    docs_root = REPO_ROOT / "docs"
    active_docs = [
        REPO_ROOT / "README.md",
        REPO_ROOT / "AGENTS.md",
        REPO_ROOT / "CLAUDE.md",
        REPO_ROOT / ".claude" / "README.md",
    ]
    active_docs.extend(path for path in docs_root.rglob("*.md") if "archive" not in path.parts)
    return active_docs


def test_selected_docs_reference_existing_repo_paths() -> None:
    for doc_path in DOCS_TO_CHECK:
        text = doc_path.read_text(encoding="utf-8")

        for target in MARKDOWN_LINK_RE.findall(text):
            resolved = _resolve_link_target(doc_path, target)
            if resolved is None:
                continue
            _assert_path_exists(doc_path, target, resolved)
            _assert_link_anchor_exists(doc_path, target, resolved)

        for candidate in INLINE_PATH_RE.findall(text):
            resolved = _resolve_inline_path(candidate)
            if resolved is None:
                continue
            _assert_path_exists(doc_path, candidate, resolved)

        for label, pattern in FORBIDDEN_TEXT_PATTERNS.items():
            assert pattern.search(text) is None, (
                f"{doc_path.relative_to(REPO_ROOT)} still references {label}: {pattern.pattern!r}"
            )


def test_active_docs_do_not_link_into_docs_archive() -> None:
    archive_root = (REPO_ROOT / "docs" / "archive").resolve()

    for doc_path in _active_docs_for_archive_link_check():
        text = doc_path.read_text(encoding="utf-8")

        for target in MARKDOWN_LINK_RE.findall(text):
            resolved = _resolve_link_target(doc_path, target)
            if resolved is None:
                continue
            assert archive_root not in {resolved, *resolved.parents}, (
                f"{doc_path.relative_to(REPO_ROOT)} links into docs/archive via {target!r}"
            )

        for candidate in INLINE_PATH_RE.findall(text):
            resolved = _resolve_inline_path(candidate)
            if resolved is None:
                continue
            assert archive_root not in {resolved, *resolved.parents}, (
                f"{doc_path.relative_to(REPO_ROOT)} references docs/archive via {candidate!r}"
            )


def test_architecture_documents_audio_identity_and_full_hash_paths() -> None:
    architecture = _normalized_prose(
        (REPO_ROOT / "docs" / "architecture.md").read_text(encoding="utf-8")
    )
    data_model = _normalized_prose(
        (REPO_ROOT / "docs" / "data-model.md").read_text(encoding="utf-8")
    )

    assert "decoded signed 16-bit PCM" in data_model
    assert "container-only metadata does not" in architecture
    assert "full 64-character SHA-256" in architecture
    assert "writers do not create truncated hash directories" in data_model


def test_active_configuration_docs_use_full_audio_hash_terminology() -> None:
    expected_examples = {
        REPO_ROOT
        / "besedy"
        / "config"
        / "settings.py": "{workflow}/{output_component}/{audio_hash}/transcript.json",
        REPO_ROOT / "besedy.toml.example": "workflow/output-component/full-audio-hash",
    }

    for path, expected_example in expected_examples.items():
        text = path.read_text(encoding="utf-8")
        assert expected_example in text
        assert "{backend}/{model}/{hash_prefix}" not in text
