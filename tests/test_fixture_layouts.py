"""Test fixtures must not keep retired transcript layouts alive.

Every transcription output component ends in ``@lang-<code>`` and the NeMo frame
VAD component carries its full name. Fixtures that spell the old unsuffixed key
would keep passing while the real layout regressed.
"""

from __future__ import annotations

import re
from pathlib import Path

TESTS = Path(__file__).resolve().parent

UNSUFFIXED_BACKEND = re.compile(r"large-v3@silero_vad_v6(?!@lang)")
SHORT_FRAME_VAD = re.compile(r"@frame_vad(?!_multilingual)")

# Tests that spell the old key on purpose.
ALLOWED = {
    # Normalization maps a three-part key to the two-part form; it adds no language.
    "test_rag_retrieval_chunking.py": UNSUFFIXED_BACKEND,
    # Selecting a workflow against an explicit legacy RAG key.
    "test_pipeline.py": UNSUFFIXED_BACKEND,
}


def test_no_fixture_spells_a_retired_transcript_component() -> None:
    offenders: list[str] = []
    for path in sorted(TESTS.rglob("*.py")):
        if path.name == Path(__file__).name:
            continue
        allowed = ALLOWED.get(path.name)
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for pattern in (UNSUFFIXED_BACKEND, SHORT_FRAME_VAD):
                if pattern.search(line) and pattern is not allowed:
                    offenders.append(f"{path.relative_to(TESTS)}:{number}: {line.strip()}")

    assert not offenders, "retired transcript component in a fixture:\n" + "\n".join(offenders)
