"""Preflight and idempotence of the Czech transcript path migration."""

from __future__ import annotations

import json

import pytest

from scripts.migrate_czech_transcript_paths import (
    plan_merged_slot_rewrites,
    plan_moves,
    rewrite_merged_slots,
)


def test_plan_moves_only_unsuffixed_transcription_variants(tmp_path) -> None:
    root = tmp_path / "transcripts_20260929_120000"
    old = root / "faster-whisper" / "large-v3@silero"
    old.mkdir(parents=True)
    (old / "hash" / "transcript.json").parent.mkdir()
    (old / "hash" / "transcript.json").write_text("{}")
    (root / "faster-whisper" / "large-v3@silero@lang-auto").mkdir()
    (root / "faster-whisper" / ".DS_Store").write_text("metadata")
    (root / "whisperx" / "model@lang-cs").mkdir(parents=True)
    (root / "speaker_diarization" / "pyannote").mkdir(parents=True)

    moves = plan_moves([root], {"faster-whisper", "whisperx"})
    assert moves == [(old, old.with_name("large-v3@silero@lang-cs"))]

    old.rename(moves[0][1])
    assert plan_moves([root], {"faster-whisper", "whisperx"}) == []
    assert (moves[0][1] / "hash" / "transcript.json").read_text() == "{}"
    assert plan_moves([root], {"faster-whisper"}, rollback=True) == [(moves[0][1], old)]


def test_plan_moves_rejects_collisions_before_any_move(tmp_path) -> None:
    root = tmp_path / "transcripts_20260929_120000"
    (root / "faster-whisper" / "model").mkdir(parents=True)
    (root / "faster-whisper" / "model@lang-cs").mkdir()

    with pytest.raises(ValueError, match="Both Czech variant paths exist"):
        plan_moves([root], {"faster-whisper"})


def test_plan_moves_rejects_symlink_root(tmp_path) -> None:
    root = tmp_path / "transcripts_20260929_120000"
    root.mkdir()
    alias = tmp_path / "transcripts_current"
    alias.symlink_to(root)

    with pytest.raises(ValueError, match="timestamped transcript directory"):
        plan_moves([alias], {"faster-whisper"})


def test_merged_slots_update_model_labels_without_changing_transcript_text(tmp_path) -> None:
    root = tmp_path / "transcripts_merged_20260929_120000"
    path = root / "hash" / "slots.json"
    path.parent.mkdir(parents=True)
    source = {
        "meta": {"models": ["faster-whisper/model", "whisperx/model@lang-auto"]},
        "slots": [
            {"candidates": [{"model": "faster-whisper/model", "text": "faster-whisper/model"}]}
        ],
    }
    path.write_text(json.dumps(source), encoding="utf-8")

    rewrites = plan_merged_slot_rewrites([root], {"faster-whisper", "whisperx"})
    assert rewrites == [path]
    rewrite_merged_slots(path, {"faster-whisper", "whisperx"})
    updated = json.loads(path.read_text())
    assert updated["meta"]["models"] == [
        "faster-whisper/model@lang-cs",
        "whisperx/model@lang-auto",
    ]
    assert updated["slots"][0]["candidates"] == [
        {"model": "faster-whisper/model@lang-cs", "text": "faster-whisper/model"}
    ]
    assert plan_merged_slot_rewrites([root], {"faster-whisper", "whisperx"}) == []
    assert plan_merged_slot_rewrites([root], {"faster-whisper"}, rollback=True) == [path]
    rewrite_merged_slots(path, {"faster-whisper"}, rollback=True)
    assert json.loads(path.read_text()) == source
