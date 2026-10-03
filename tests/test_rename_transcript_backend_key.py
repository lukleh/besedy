"""scripts/rename_transcript_backend_key.sql rewrites every column that stores a backend key."""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "rename_transcript_backend_key.sql"
SCHEMA = REPO_ROOT / "web" / "prisma" / "schema.prisma"

# A text column that holds a backend key but is not named after it.
EXTRA_COLUMNS = {"previous_source_ref"}


def _backend_columns() -> set[str]:
    """Columns of String fields named like `*backend*`, as the database names them."""
    columns: set[str] = set()
    for line in SCHEMA.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s+(\w*[Bb]ackend\w*)\s+String\??\s*(.*)$", line)
        if not match:
            continue
        mapped = re.search(r'@map\("([^"]+)"\)', match.group(2))
        columns.add(mapped.group(1) if mapped else match.group(1))
    return columns


def test_the_script_covers_every_backend_key_column() -> None:
    script = SCRIPT.read_text(encoding="utf-8")
    columns = _backend_columns() | EXTRA_COLUMNS

    assert {"backend", "source_backend"} <= columns
    # An UPDATE assigns the column: `SET <column> = ...`, not a mention in a
    # comment or a WHERE clause.
    missing = sorted(
        column for column in columns if not re.search(rf"\bSET\s+{column}\s*=", script)
    )

    assert not missing, f"scripts/rename_transcript_backend_key.sql does not rewrite: {missing}"


def test_the_script_rewrites_only_machine_references_of_publications() -> None:
    script = SCRIPT.read_text(encoding="utf-8")

    # previous_source_ref is a publication id when the previous source was a
    # publication; only a machine key may be rewritten.
    assert "previous_source_kind = 'machine'" in script
