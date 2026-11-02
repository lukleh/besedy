"""Scoring ASR output against corrected text (ADR 0012).

One text normalizer and one word and character error rate for every
comparison the training loop makes: the trainer's dev score, the
production-path evaluation of a CTranslate2 model (``catalog training-eval``)
and the machine-text baseline read from a dataset's manifest. Numbers from
those places are comparable only because they all come through here.

Normalization lowercases, turns every punctuation and symbol character into a
space, collapses whitespace and keeps diacritics and digits (NFC). Numbers are
deliberately not converted between digits and words: the correction guide
writes numbers as digits, so a model writing "dvě" for "2" makes a real error
that a number normalizer would hide. Hyphens count as punctuation, so a cut
word "pro-" scores the same as "pro" and a hyphenated compound splits in two.

The module has no third-party dependencies, so the GPU-host training project
and the faster-whisper image import it as it is.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

EVAL_REPORT_SCHEMA_VERSION = 1
MACHINE_SYSTEM = "machine text (production transcript, from the manifest)"

_AUDIO_HASH = re.compile(r"^[0-9a-f]{64}$")


def normalize_text(text: str) -> str:
    """Lowercase, punctuation and symbols to spaces, whitespace unified; diacritics kept."""
    chars: list[str] = []
    for char in unicodedata.normalize("NFC", text).lower():
        category = unicodedata.category(char)
        if category[0] in "PSZC" or char.isspace():
            chars.append(" ")
        else:
            chars.append(char)
    return " ".join("".join(chars).split())


def edit_distance(a: Sequence[Any], b: Sequence[Any]) -> int:
    """Levenshtein distance over two sequences (words or characters).

    The common prefix and suffix are stripped first: hypotheses mostly match
    their reference, so the quadratic dynamic programme runs over the
    differing middle only.
    """
    start = 0
    while start < len(a) and start < len(b) and a[start] == b[start]:
        start += 1
    end_a, end_b = len(a), len(b)
    while end_a > start and end_b > start and a[end_a - 1] == b[end_b - 1]:
        end_a -= 1
        end_b -= 1
    a, b = a[start:end_a], b[start:end_b]
    if not a:
        return len(b)
    if not b:
        return len(a)
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, item_a in enumerate(a, start=1):
        current = [i]
        for j, item_b in enumerate(b, start=1):
            cost = 0 if item_a == item_b else 1
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost))
        previous = current
    return previous[-1]


@dataclass(frozen=True)
class RowScore:
    """One reference/hypothesis pair with its raw and normalized error counts."""

    audio: str
    audio_hash: str
    chunk: int
    ref: str
    hyp: str
    ref_norm: str
    hyp_norm: str
    raw_words: int
    raw_word_errors: int
    words: int
    word_errors: int
    chars: int
    char_errors: int

    def to_json(self) -> dict[str, Any]:
        return {
            "audio": self.audio,
            "audio_hash": self.audio_hash,
            "chunk": self.chunk,
            "ref": self.ref,
            "hyp": self.hyp,
            "ref_norm": self.ref_norm,
            "hyp_norm": self.hyp_norm,
            "raw_words": self.raw_words,
            "raw_word_errors": self.raw_word_errors,
            "words": self.words,
            "word_errors": self.word_errors,
            "chars": self.chars,
            "char_errors": self.char_errors,
        }


def score_pair(row: Mapping[str, Any], hyp: str) -> RowScore:
    """Score one hypothesis against a manifest row's corrected text."""
    ref = str(row["text"])
    ref_raw, hyp_raw = ref.split(), hyp.split()
    ref_norm, hyp_norm = normalize_text(ref), normalize_text(hyp)
    ref_words, hyp_words = ref_norm.split(), hyp_norm.split()
    return RowScore(
        audio=str(row["audio"]),
        audio_hash=str(row["audio_hash"]),
        chunk=int(row["chunk"]),
        ref=ref,
        hyp=hyp,
        ref_norm=ref_norm,
        hyp_norm=hyp_norm,
        raw_words=len(ref_raw),
        raw_word_errors=edit_distance(ref_raw, hyp_raw),
        words=len(ref_words),
        word_errors=edit_distance(ref_words, hyp_words),
        chars=len(ref_norm),
        char_errors=edit_distance(ref_norm, hyp_norm),
    )


def score_rows(rows: Sequence[Mapping[str, Any]], hyps: Sequence[str]) -> list[RowScore]:
    if len(rows) != len(hyps):
        raise ValueError(f"{len(rows)} rows but {len(hyps)} hypotheses")
    return [score_pair(row, hyp) for row, hyp in zip(rows, hyps, strict=True)]


def _rate(errors: int, total: int) -> float | None:
    return round(errors / total, 4) if total else None


def summarize(scores: Sequence[RowScore]) -> dict[str, Any]:
    """Corpus-level rates: errors summed over rows divided by reference length summed."""
    words = sum(s.words for s in scores)
    raw_words = sum(s.raw_words for s in scores)
    chars = sum(s.chars for s in scores)
    return {
        "rows": len(scores),
        "ref_words": words,
        "wer_raw": _rate(sum(s.raw_word_errors for s in scores), raw_words),
        "wer": _rate(sum(s.word_errors for s in scores), words),
        "cer": _rate(sum(s.char_errors for s in scores), chars),
        "empty_reference_rows": sum(1 for s in scores if s.words == 0),
    }


def write_hypotheses(path: Path, scores: Iterable[RowScore]) -> None:
    """One JSON line per row, worst normalized WER first, so disagreements can be read."""
    ordered = sorted(
        scores, key=lambda s: (-(s.word_errors / s.words if s.words else s.word_errors), s.audio)
    )
    with path.open("w", encoding="utf-8") as handle:
        for score in ordered:
            handle.write(json.dumps(score.to_json(), ensure_ascii=False) + "\n")


# --- splits -----------------------------------------------------------------


def split_dev_recordings(
    audio_hashes: Iterable[str], fraction: float, seed: int
) -> tuple[list[str], list[str]]:
    """Set whole recordings aside for development, deterministically.

    Returns ``(train_hashes, dev_hashes)``, both sorted. At least one
    recording and at most all but one go to dev when ``fraction`` is positive;
    a single recording cannot be split and leaves dev empty.
    """
    if not 0 <= fraction < 1:
        raise ValueError(f"dev fraction must be in [0, 1), got {fraction}")
    unique = sorted(set(audio_hashes))
    if fraction == 0 or len(unique) < 2:
        return unique, []
    # Rounded first: 0.07 * 100 is 7.000000000000001 in binary floating point.
    count = min(max(1, math.ceil(round(fraction * len(unique), 9))), len(unique) - 1)
    order = list(unique)
    random.Random(seed).shuffle(order)
    dev = sorted(order[:count])
    train = sorted(set(unique) - set(dev))
    return train, dev


def shuffled_rows(
    rows: Iterable[Mapping[str, Any]], seed: int, limit: int | None = None
) -> list[Mapping[str, Any]]:
    """Rows in a seeded random order (never file order), optionally capped."""
    ordered = sorted(rows, key=lambda row: (str(row["audio_hash"]), int(row["chunk"])))
    random.Random(seed).shuffle(ordered)
    return ordered[:limit] if limit else ordered


# --- datasets ---------------------------------------------------------------


def load_manifest(data_dir: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with (data_dir / "manifest.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def select_rows(
    rows: Iterable[Mapping[str, Any]], split: str, recordings: Iterable[str] | None = None
) -> list[Mapping[str, Any]]:
    """The rows of one split, limited to the given recordings when a list is given."""
    wanted = None if recordings is None else set(recordings)
    return [
        row
        for row in rows
        if row["split"] == split and (wanted is None or row["audio_hash"] in wanted)
    ]


RECORDINGS_LIST_VERSION = 1


def load_recordings(path: Path) -> set[str]:
    """Audio hashes from a ``{"version": 1, "audio_hashes": [...]}`` file, a JSON list or lines.

    The one parser of that format: the catalog's ``test-recordings.json``, the
    trainer's ``dev-recordings.json`` and ``training-eval --recordings`` all
    read through here. A missing file raises FileNotFoundError, anything else
    wrong with it ValueError.
    """
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return set()
    if raw.startswith("{"):
        document = json.loads(raw)
        if document.get("version") != RECORDINGS_LIST_VERSION:
            raise ValueError(
                f"{path} is a recordings list of version {document.get('version')!r}, "
                f"expected {RECORDINGS_LIST_VERSION}"
            )
        hashes = document.get("audio_hashes")
        if not isinstance(hashes, list):
            raise ValueError(f"{path} has no audio_hashes list")
    else:
        hashes = json.loads(raw) if raw.startswith("[") else raw.split()
    result = {str(value).strip() for value in hashes if str(value).strip()}
    for value in result:
        if not _AUDIO_HASH.match(value):
            raise ValueError(f"{path} names {value!r}, not a 64-character audio hash")
    return result


def write_recordings(path: Path, audio_hashes: Iterable[str]) -> None:
    document = {"version": RECORDINGS_LIST_VERSION, "audio_hashes": sorted(set(audio_hashes))}
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def rows_fingerprint(rows: Iterable[Mapping[str, Any]]) -> str:
    """Identifies the scored chunks and their references, so reports can be compared safely.

    The file name alone would match across exports of the same chunks with
    different labels (fillers stripped or not, corrections made since), so the
    corrected and machine texts are part of the identity.
    """
    lines = sorted(
        json.dumps([str(row["audio"]), str(row["text"]), row.get("machine_text")]) for row in rows
    )
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def dataset_identity(data_dir: Path) -> dict[str, Any]:
    """What ``dataset.json`` says about the dataset, with its path."""
    identity: dict[str, Any] = {"path": str(data_dir)}
    try:
        dataset = json.loads((data_dir / "dataset.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return identity
    for key in ("schema_version", "catalog_id", "exported_at"):
        if key in dataset:
            identity[key] = dataset[key]
    policy = dataset.get("policy") or {}
    identity["test_recordings"] = policy.get("test_recordings")
    identity["strip_fillers"] = policy.get("strip_fillers")
    return identity


def machine_baseline(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """Score the manifest's machine text against the corrected text, when it carries one."""
    with_machine = [row for row in rows if row.get("machine_text") is not None]
    if not with_machine:
        return None
    scores = score_rows(with_machine, [str(row["machine_text"]) for row in with_machine])
    return {**summarize(scores), "rows_without_machine_text": len(rows) - len(with_machine)}


# --- reports ----------------------------------------------------------------


def build_report(
    *,
    system: str,
    dataset: Mapping[str, Any],
    split: str,
    rows: Sequence[Mapping[str, Any]],
    scores: Sequence[RowScore] | None,
    model: Mapping[str, Any] | None,
    options: Mapping[str, Any] | None,
    git_commit: str | None,
    versions: Mapping[str, Any] | None = None,
    recordings_source: str | None = None,
) -> dict[str, Any]:
    """The report of one scoring run; ``scores`` is None for a machine-text-only run."""
    return {
        "schema_version": EVAL_REPORT_SCHEMA_VERSION,
        "system": system,
        "git_commit": git_commit,
        "versions": dict(versions or {}),
        "dataset": dict(dataset),
        "split": split,
        "recordings_source": recordings_source,
        "rows": len(rows),
        "rows_sha256": rows_fingerprint(rows),
        "hours": round(sum(float(row.get("duration") or 0.0) for row in rows) / 3600, 3),
        "model": dict(model) if model is not None else None,
        "options": dict(options) if options is not None else None,
        "scores": summarize(scores) if scores is not None else None,
        "machine_baseline": machine_baseline(rows),
    }


def _format_rate(value: float | None) -> str:
    return "-" if value is None else f"{100 * value:.2f} %"


def comparison_table(reports: Sequence[Mapping[str, Any]]) -> str:
    """One table over reports scored on identical rows; refuses mismatched ones.

    Identical rows means the same chunks with the same references, so the
    machine baselines of the reports must agree as well; the first one is shown.
    """
    if not reports:
        raise ValueError("No reports to compare")
    first = reports[0]
    for report in reports[1:]:
        if report.get("rows_sha256") != first.get("rows_sha256"):
            raise ValueError(
                f"{report.get('system')} was scored on different rows than {first.get('system')} "
                f"({report.get('rows')} vs {first.get('rows')} rows); compare reports of one "
                "dataset and split only"
            )
    baselines = [r["machine_baseline"] for r in reports if r.get("machine_baseline")]
    for baseline in baselines[1:]:
        if baseline != baselines[0]:
            raise ValueError(
                "The reports carry different machine baselines on the same rows; "
                "they were not scored on one dataset"
            )
    lines: list[tuple[str, Mapping[str, Any]]] = []
    if baselines:
        lines.append((MACHINE_SYSTEM, baselines[0]))
    lines.extend((str(r.get("system")), r["scores"]) for r in reports if r.get("scores"))
    if not lines:
        raise ValueError("None of the reports carries scores")

    header = ("system", "rows", "ref words", "WER raw", "WER norm", "CER norm")
    body = [
        (
            name,
            str(line["rows"]),
            str(line["ref_words"]),
            _format_rate(line["wer_raw"]),
            _format_rate(line["wer"]),
            _format_rate(line["cer"]),
        )
        for name, line in lines
    ]
    widths = [max(len(row[i]) for row in (header, *body)) for i in range(len(header))]

    def fmt(row: Sequence[str]) -> str:
        cells = [
            cell.ljust(widths[i]) if i == 0 else cell.rjust(widths[i]) for i, cell in enumerate(row)
        ]
        return "| " + " | ".join(cells) + " |"

    dataset = first.get("dataset") or {}
    title = (
        f"{first.get('split')} split of {dataset.get('path')} "
        f"({first.get('rows')} chunks, {first.get('hours')} h)"
    )
    return "\n".join(
        [title, fmt(header), "|" + "|".join("-" * (w + 2) for w in widths) + "|", *map(fmt, body)]
    )
