"""Corrected chunks become exactly the model's input with their labels (ADR 0012)."""

from __future__ import annotations

import array
import hashlib
import json
import wave
from pathlib import Path

import pytest

from besedy.lib.correction_training import (
    TrainingExportError,
    build_dataset,
    load_test_recordings,
    strip_fillers,
)

SR = 16000
HASH = "a" * 64
CATALOG = "20251222_144441"
WORKSPACE = "11111111-2222-3333-4444-555555555555"
# Three regions of one chunk, the last after a 1 s pause: spans [0-1] and [2].
REGIONS = [(0, 4 * SR), (int(4.5 * SR), int(8.5 * SR)), (int(9.5 * SR), int(13.5 * SR))]


def _source() -> dict:
    return {
        "meta": {
            "generation_params": {
                "transcription_options": {
                    "clip_timestamps": [{"start": a, "end": b} for a, b in REGIONS]
                }
            }
        },
        "segments": [{"text": "x", "words": []}],
    }


@pytest.fixture
def tree(tmp_path: Path) -> tuple[dict, Path, Path]:
    root = tmp_path / "corrections"
    source_dir = root / f"corrections_{CATALOG}" / WORKSPACE / "source"
    source_dir.mkdir(parents=True)
    source_text = json.dumps(_source())
    (source_dir / "transcript.json").write_text(source_text, encoding="utf-8")

    # Each region holds its own sample value, so the rebuilt chunk shows what was taken.
    samples = array.array("h", [0] * (14 * SR))
    for value, (start, end) in enumerate(REGIONS, start=1):
        for i in range(start, end):
            samples[i] = value * 100
    audio = tmp_path / "audio_staged" / f"{HASH}.wav"
    audio.parent.mkdir()
    with wave.open(str(audio), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(samples.tobytes())

    export = {
        "schemaVersion": 1,
        "exportedAt": "2026-10-20T00:00:00.000Z",
        "catalogId": CATALOG,
        "policy": {"minHeardFraction": 0.9},
        "workspaces": [
            {
                "workspaceId": WORKSPACE,
                "audioHash": HASH,
                "sourceBackend": "faster-whisper/large-v3@silero_vad_v6@lang-cs",
                "sourceFingerprint": hashlib.sha256(source_text.encode("utf-8")).hexdigest(),
                "segmentationVersion": "chunks-v1",
                "stagedAudio": {
                    "path": str(audio),
                    "size": audio.stat().st_size,
                    "sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                },
                "chunks": [
                    {
                        "chunk": 0,
                        "eligible": True,
                        "reasons": [],
                        "spans": [
                            {
                                "spanId": "s0",
                                "ordinal": 0,
                                "revisionId": "r0",
                                "text": "Ehm, dobrý den.",
                                "firstRegion": 0,
                                "lastRegion": 1,
                            },
                            {
                                "spanId": "s1",
                                "ordinal": 1,
                                "revisionId": "r1",
                                "text": "Vítejte.",
                                "firstRegion": 2,
                                "lastRegion": 2,
                            },
                        ],
                    }
                ],
            }
        ],
    }
    return export, root, tmp_path / "dataset"


def _rows(output: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in (output / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
    ]


def test_a_chunk_is_rebuilt_as_the_model_heard_it(tree) -> None:
    export, root, output = tree
    summary = build_dataset(export, root, output, verify_audio_hash=True)

    rows = _rows(output)
    assert summary.chunks_written == 1 and summary.splits["train"] == 1
    assert rows[0]["text"] == "Ehm, dobrý den. Vítejte."
    assert rows[0]["revision_ids"] == ["r0", "r1"]
    with wave.open(str(output / rows[0]["audio"]), "rb") as rebuilt:
        frames = array.array("h", rebuilt.readframes(rebuilt.getnframes()))
    # 4 + 4 + 4 s of speech, silence between regions left out, in order.
    assert len(frames) == 12 * SR
    assert (frames[0], frames[4 * SR], frames[8 * SR], frames[-1]) == (100, 200, 300, 300)
    assert rows[0]["duration"] == 12.0
    assert json.loads((output / "dataset.json").read_text())["summary"]["chunks_written"] == 1


def test_test_recordings_and_fillers_follow_the_export_options(tree, tmp_path: Path) -> None:
    export, root, output = tree
    test_file = tmp_path / "test.txt"
    test_file.write_text(f"{HASH}\n", encoding="utf-8")
    build_dataset(
        export, root, output, test_recordings=load_test_recordings(test_file), keep_fillers=False
    )
    row = _rows(output)[0]
    assert row["split"] == "test"
    assert row["text"] == "dobrý den. Vítejte."


def test_excluded_chunks_are_counted_with_their_reasons(tree) -> None:
    export, root, output = tree
    chunk = export["workspaces"][0]["chunks"][0]
    chunk["eligible"] = False
    chunk["reasons"] = ["span 0 is flagged UNCLEAR", "span 1 is needs_second_approval"]
    summary = build_dataset(export, root, output)
    assert summary.chunks_written == 0 and summary.chunks_excluded == 1
    assert summary.exclusion_reasons == {"is flagged UNCLEAR": 1, "is needs_second_approval": 1}


@pytest.mark.parametrize(
    ("damage", "message"),
    [
        (lambda e: e["workspaces"][0].update(sourceFingerprint="0" * 64), "changed"),
        (lambda e: e["workspaces"][0].update(segmentationVersion="chunks-v0"), "cut with"),
        (lambda e: e["workspaces"][0]["stagedAudio"].update(size=1), "changed size"),
        (lambda e: e["workspaces"][0]["chunks"][0]["spans"].pop(), "do not cover"),
        (lambda e: e.update(schemaVersion=2), "schema"),
    ],
)
def test_a_dataset_is_refused_when_its_sources_do_not_match(tree, damage, message: str) -> None:
    export, root, output = tree
    damage(export)
    with pytest.raises(TrainingExportError, match=message):
        build_dataset(export, root, output)


def test_strip_fillers_removes_only_the_fixed_spellings() -> None:
    assert strip_fillers("Ehm, tak hm jsme šli. Mhm.") == "tak jsme šli."
    assert strip_fillers("hmotnost a hmyz") == "hmotnost a hmyz"
    assert strip_fillers("eee… no jo") == "no jo"
    assert strip_fillers("Ehm? Ano. Hm! Dobře. Mhm: tak") == "Ano. Dobře. tak"


def test_the_command_writes_next_to_the_audio_artifacts(tree, tmp_path: Path, monkeypatch) -> None:
    from besedy.cli import catalog as catalog_cli

    export, root, _output = tree
    export_file = tmp_path / "export.json"
    export_file.write_text(json.dumps(export), encoding="utf-8")
    artifacts = tmp_path / "audio_artifacts"
    monkeypatch.setenv("BESEDY_AUDIO_ARTIFACTS_ROOT", str(artifacts))
    monkeypatch.setattr(catalog_cli, "install_signal_handlers", lambda: None)

    argv = ["training-export", "--export-json", str(export_file), "--corrections-root", str(root)]
    assert catalog_cli.main(argv) == 0
    latest = artifacts / "training" / "training_export"
    assert latest.is_symlink()
    assert latest.resolve().name.startswith("training_export_")
    assert (latest / "manifest.jsonl").is_file()
