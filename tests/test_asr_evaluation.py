"""One normalizer, one WER/CER and one dev split for every ASR score (ADR 0012)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from besedy.lib import asr_evaluation as ev

HASHES = [f"{i:064x}" for i in range(20)]


def _row(i: int, text: str, audio_hash: str = HASHES[0], **extra) -> dict:
    return {
        "audio": f"audio/{audio_hash[:16]}_{i:05d}.wav",
        "audio_hash": audio_hash,
        "chunk": i,
        "text": text,
        "duration": 10.0,
        "split": "test",
        **extra,
    }


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Dobrý den, „pane“ Novák… 2 hodiny!", "dobrý den pane novák 2 hodiny"),
        ("  Více\tmezer\n a   tabulátorů ", "více mezer a tabulátorů"),
        ("Šli jsme do pro- protože pršelo.", "šli jsme do pro protože pršelo"),
        ("v roce 1989, v 8:30, 50 %", "v roce 1989 v 8 30 50"),
        ("ŘEČ — Čeština (na „workshopu“)", "řeč čeština na workshopu"),
        ("e-mail", "e mail"),
        ("", ""),
        ("á", "á"),  # NFC: a decomposed accent equals the composed letter
    ],
)
def test_normalize_text_lowercases_and_drops_punctuation_but_keeps_diacritics(
    text: str, expected: str
) -> None:
    assert ev.normalize_text(text) == expected


def test_numbers_are_not_converted_between_digits_and_words() -> None:
    # The guide writes digits; a model writing the word is a real error (module docstring).
    assert ev.normalize_text("2 hodiny") != ev.normalize_text("dvě hodiny")


@pytest.mark.parametrize(
    ("a", "b", "distance"),
    [
        ("kitten", "sitting", 3),
        ("", "abc", 3),
        ("abc", "", 3),
        ("same", "same", 0),
        ("", "", 0),
        # Shared prefix and suffix around the difference, and one side a prefix of the other.
        ("dobrý den pane", "dobrej den pane", 2),
        ("dobrý den", "dobrý den pane", 5),
        ("abcabc", "abc", 3),
    ],
)
def test_edit_distance(a: str, b: str, distance: int) -> None:
    assert ev.edit_distance(a, b) == distance
    assert ev.edit_distance(a.split(), b.split()) == (0 if a == b else 1)


def test_score_pair_counts_raw_and_normalized_errors_separately() -> None:
    score = ev.score_pair(_row(0, "Dobrý den, pane."), "dobrý den pane")
    assert (score.raw_words, score.raw_word_errors) == (3, 3)
    assert (score.words, score.word_errors) == (3, 0)
    assert (score.chars, score.char_errors) == (len("dobrý den pane"), 0)
    worse = ev.score_pair(_row(0, "Dobrý den, pane."), "dobrej den")
    assert worse.word_errors == 2  # one substitution, one deletion
    assert worse.char_errors == ev.edit_distance("dobrý den pane", "dobrej den")


def test_summarize_divides_summed_errors_by_summed_reference_length() -> None:
    scores = ev.score_rows(
        [_row(0, "jedna dvě"), _row(1, "a b c d e f g h"), _row(2, "")],
        ["jedna tři", "a b c d e f g h", "něco"],
    )
    summary = ev.summarize(scores)
    assert summary["rows"] == 3 and summary["ref_words"] == 10
    assert summary["wer"] == pytest.approx((1 + 0 + 1) / 10)
    assert summary["wer_raw"] == summary["wer"]
    assert summary["empty_reference_rows"] == 1
    assert ev.summarize([])["wer"] is None


def test_write_hypotheses_lists_the_worst_chunks_first(tmp_path: Path) -> None:
    scores = ev.score_rows(
        [_row(0, "a b c d"), _row(1, "a b"), _row(2, "x y z")], ["a b c d", "c d", "x y q"]
    )
    path = tmp_path / "hypotheses.jsonl"
    ev.write_hypotheses(path, scores)
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert [row["chunk"] for row in rows] == [1, 2, 0]
    assert rows[0] == {
        "audio": scores[1].audio,
        "audio_hash": HASHES[0],
        "chunk": 1,
        "ref": "a b",
        "hyp": "c d",
        "ref_norm": "a b",
        "hyp_norm": "c d",
        "raw_words": 2,
        "raw_word_errors": 2,
        "words": 2,
        "word_errors": 2,
        "chars": 3,
        "char_errors": 2,
    }


class TestDevSplit:
    def test_holds_out_whole_recordings_deterministically(self) -> None:
        # One entry per chunk, several chunks per recording, in file order.
        chunks = [h for h in HASHES for _ in range(3)]
        train, dev = ev.split_dev_recordings(chunks, 0.1, seed=1)
        assert len(dev) == 2 and len(train) == 18
        assert not set(train) & set(dev) and set(train) | set(dev) == set(HASHES)
        assert dev == sorted(dev) and train == sorted(train)
        assert ev.split_dev_recordings(reversed(chunks), 0.1, seed=1) == (train, dev)
        other = ev.split_dev_recordings(chunks, 0.1, seed=2)[1]
        assert other != dev

    def test_rounds_up_and_leaves_at_least_one_training_recording(self) -> None:
        assert len(ev.split_dev_recordings(HASHES[:3], 0.1, seed=0)[1]) == 1
        assert len(ev.split_dev_recordings(HASHES[:15], 0.1, seed=0)[1]) == 2
        assert len(ev.split_dev_recordings(HASHES[:2], 0.9, seed=0)[1]) == 1
        # 0.07 * 100 is 7.000000000000001 in floating point; still 7 recordings.
        hundred = [f"{i:064x}" for i in range(100)]
        assert len(ev.split_dev_recordings(hundred, 0.07, seed=0)[1]) == 7

    def test_a_single_recording_or_a_zero_fraction_gives_no_dev_set(self) -> None:
        assert ev.split_dev_recordings(HASHES[:1], 0.5, seed=0) == (HASHES[:1], [])
        assert ev.split_dev_recordings(HASHES[:5], 0.0, seed=0) == (sorted(HASHES[:5]), [])
        with pytest.raises(ValueError, match="fraction"):
            ev.split_dev_recordings(HASHES, 1.0, seed=0)


def test_shuffled_rows_is_seeded_and_independent_of_file_order() -> None:
    rows = [_row(i, "x", HASHES[i % 2]) for i in range(12)]
    first = ev.shuffled_rows(rows, seed=7)
    assert first == ev.shuffled_rows(list(reversed(rows)), seed=7)
    assert first != rows and sorted(r["chunk"] for r in first) == list(range(12))
    assert ev.shuffled_rows(rows, seed=7, limit=4) == first[:4]
    assert ev.shuffled_rows(rows, seed=8) != first


def test_select_rows_filters_by_split_and_recording() -> None:
    rows = [
        _row(0, "a", HASHES[0]),
        _row(1, "b", HASHES[1]),
        {**_row(2, "c", HASHES[2]), "split": "train"},
    ]
    assert [r["chunk"] for r in ev.select_rows(rows, "test")] == [0, 1]
    assert [r["chunk"] for r in ev.select_rows(rows, "test", {HASHES[1]})] == [1]
    assert [r["chunk"] for r in ev.select_rows(rows, "train")] == [2]


def test_recordings_lists_round_trip_and_accept_the_three_spellings(tmp_path: Path) -> None:
    path = tmp_path / "dev-recordings.json"
    ev.write_recordings(path, [HASHES[1], HASHES[0], HASHES[1]])
    assert json.loads(path.read_text()) == {"version": 1, "audio_hashes": [HASHES[0], HASHES[1]]}
    assert ev.load_recordings(path) == {HASHES[0], HASHES[1]}
    (tmp_path / "list.json").write_text(json.dumps([HASHES[2]]))
    assert ev.load_recordings(tmp_path / "list.json") == {HASHES[2]}
    (tmp_path / "lines.txt").write_text(f"{HASHES[3]}\n{HASHES[4]}\n")
    assert ev.load_recordings(tmp_path / "lines.txt") == {HASHES[3], HASHES[4]}
    (tmp_path / "bad.txt").write_text("abc\n")
    with pytest.raises(ValueError, match="64-character"):
        ev.load_recordings(tmp_path / "bad.txt")
    (tmp_path / "v2.json").write_text(json.dumps({"version": 2, "audio_hashes": []}))
    with pytest.raises(ValueError, match="version"):
        ev.load_recordings(tmp_path / "v2.json")
    with pytest.raises(FileNotFoundError):
        ev.load_recordings(tmp_path / "missing.json")


def test_machine_baseline_scores_the_manifest_text_against_the_label() -> None:
    rows = [
        _row(0, "dobrý den pane", machine_text="Dobrej den, pane."),
        _row(1, "a b c d", machine_text="a b c d"),
        _row(2, "x y", machine_text=None),
    ]
    baseline = ev.machine_baseline(rows)
    assert baseline is not None
    assert baseline["rows"] == 2 and baseline["rows_without_machine_text"] == 1
    assert baseline["wer"] == pytest.approx(1 / 7, abs=1e-4)
    assert baseline["wer_raw"] == pytest.approx(3 / 7, abs=1e-4)
    assert ev.machine_baseline([_row(0, "a")]) is None


def _report(system: str, rows: list[dict], hyps: list[str] | None, **extra) -> dict:
    return ev.build_report(
        system=system,
        dataset={"path": "/data/training_export", "catalog_id": "20251222_144441"},
        split="test",
        rows=rows,
        scores=ev.score_rows(rows, hyps) if hyps is not None else None,
        model={"reference": system} if hyps is not None else None,
        options={"vad_filter": True} if hyps is not None else None,
        git_commit="abc123",
        **extra,
    )


def test_build_report_fingerprints_the_scored_rows_whatever_their_order() -> None:
    rows = [_row(0, "a b", machine_text="a b"), _row(1, "c d", machine_text="c x")]
    report = _report("large-v3", rows, ["a b", "c d"], versions={"faster_whisper": "1.2.1"})
    assert (
        report["rows_sha256"]
        == _report("other", list(reversed(rows)), ["c d", "a b"])["rows_sha256"]
    )
    # The same chunks with other references (another export) are other rows.
    relabelled = [{**rows[0], "text": "a b ehm"}, rows[1]]
    assert _report("x", relabelled, ["a b", "c d"])["rows_sha256"] != report["rows_sha256"]
    assert report["system"] == "large-v3"
    assert report["scores"] == {
        "rows": 2,
        "ref_words": 4,
        "wer_raw": 0.0,
        "wer": 0.0,
        "cer": 0.0,
        "empty_reference_rows": 0,
    }
    assert report["machine_baseline"]["wer"] == pytest.approx(0.25)
    assert report["hours"] == pytest.approx(20 / 3600, abs=1e-3)
    assert report["git_commit"] == "abc123" and report["versions"] == {"faster_whisper": "1.2.1"}
    assert report["schema_version"] == ev.EVAL_REPORT_SCHEMA_VERSION


def test_comparison_table_lists_the_machine_baseline_and_every_system_once() -> None:
    rows = [_row(0, "a b c d", machine_text="a b c x"), _row(1, "e f", machine_text="e f")]
    production = _report("large-v3", rows, ["a b c d", "e x"])
    finetuned = _report("finetuned", rows, ["a b c d", "e f"])
    table = ev.comparison_table([production, finetuned])
    lines = table.splitlines()
    assert lines[0].startswith("test split of /data/training_export (2 chunks")
    assert [line.split("|")[1].strip() for line in lines[3:]] == [
        ev.MACHINE_SYSTEM,
        "large-v3",
        "finetuned",
    ]
    assert "16.67 %" in lines[3] and "16.67 %" in lines[4] and "0.00 %" in lines[5]


def test_comparison_table_refuses_reports_of_different_rows() -> None:
    rows = [_row(0, "a b"), _row(1, "c d")]
    with pytest.raises(ValueError, match="different rows"):
        ev.comparison_table([_report("x", rows, ["a b", "c d"]), _report("y", rows[:1], ["a b"])])
    with pytest.raises(ValueError, match="No reports"):
        ev.comparison_table([])
    with pytest.raises(ValueError, match="carries scores"):
        ev.comparison_table([_report("machine only", rows, None)])


def test_comparison_table_refuses_reports_whose_machine_baselines_disagree() -> None:
    rows = [_row(0, "a b", machine_text="a b"), _row(1, "c d", machine_text="c d")]
    first = _report("x", rows, ["a b", "c d"])
    second = _report("y", rows, ["a b", "c d"])
    second["machine_baseline"]["wer"] = 0.5
    with pytest.raises(ValueError, match="different machine baselines"):
        ev.comparison_table([first, second])
    # A report without a baseline (an older one) compares fine.
    second["machine_baseline"] = None
    assert "| y " in ev.comparison_table([first, second])
