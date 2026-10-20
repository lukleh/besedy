"""Corrected chunks become exactly the model's input with their labels (ADR 0012)."""

from __future__ import annotations

import array
import hashlib
import json
import logging
import re
import wave
from pathlib import Path

import pytest

from besedy.lib.correction_training import (
    DEFAULT_TEST_RECORDINGS_PATH,
    SPAN_COVERAGE_MISMATCH,
    TrainingExportError,
    build_dataset,
    load_test_recordings,
    merge_training_exports,
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
    summary = build_dataset(export, root, output)

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
        export,
        root,
        output,
        test_recordings=load_test_recordings(test_file, CATALOG),
        test_recordings_source=str(test_file),
        keep_fillers=False,
    )
    row = _rows(output)[0]
    assert row["split"] == "test"
    assert row["text"] == "dobrý den. Vítejte."
    policy = json.loads((output / "dataset.json").read_text())["policy"]
    assert policy["strip_fillers"] is True and "lowercase" in policy["strip_fillers_note"]
    assert policy["test_recordings"] == [HASH]
    assert policy["test_recordings_source"] == str(test_file)


def test_the_repository_lists_test_recordings_per_catalog(tmp_path: Path) -> None:
    document = json.loads(DEFAULT_TEST_RECORDINGS_PATH.read_text(encoding="utf-8"))
    assert document["version"] == 1
    assert isinstance(document["catalogs"], dict)
    for catalog_id, hashes in document["catalogs"].items():
        assert re.fullmatch(r"\d{8}_\d{6}", catalog_id), catalog_id
        assert isinstance(hashes, list) and len(hashes) == len(set(hashes))
        for value in hashes:
            assert re.fullmatch(r"[0-9a-f]{64}", value), value

    listed = tmp_path / "test-recordings.json"
    listed.write_text(json.dumps({"version": 1, "catalogs": {CATALOG: [HASH]}}), encoding="utf-8")
    assert load_test_recordings(listed, CATALOG) == {HASH}
    assert load_test_recordings(listed, "20200101_000000") == set()
    listed.write_text(json.dumps({"version": 2, "catalogs": {}}), encoding="utf-8")
    with pytest.raises(TrainingExportError, match="version"):
        load_test_recordings(listed, CATALOG)
    listed.write_text(json.dumps(["ABC"]), encoding="utf-8")
    with pytest.raises(TrainingExportError, match="64-character"):
        load_test_recordings(listed, CATALOG)


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
        (lambda e: e["workspaces"][0]["stagedAudio"].update(sha256="0" * 64), "changed"),
        (lambda e: e.update(schemaVersion=2), "schema"),
    ],
)
def test_a_dataset_is_refused_when_its_sources_do_not_match(tree, damage, message: str) -> None:
    export, root, output = tree
    damage(export)
    with pytest.raises(TrainingExportError, match=message):
        build_dataset(export, root, output)


def test_the_staged_audio_hash_is_trusted_only_on_request(tree) -> None:
    export, root, output = tree
    export["workspaces"][0]["stagedAudio"]["sha256"] = "0" * 64
    summary = build_dataset(export, root, output, verify_audio_hash=False)
    assert summary.chunks_written == 1


def test_a_chunk_whose_spans_do_not_cover_it_is_excluded(tree, caplog) -> None:
    export, root, output = tree
    export["workspaces"][0]["chunks"][0]["spans"].pop()
    with caplog.at_level(logging.WARNING, logger="besedy.lib.correction_training"):
        summary = build_dataset(export, root, output)
    assert summary.chunks_written == 0 and summary.chunks_excluded == 1
    assert summary.exclusion_reasons == {SPAN_COVERAGE_MISMATCH: 1}
    assert _rows(output) == []
    assert any(WORKSPACE in r.message and "chunk 0" in r.message for r in caplog.records)


def _replace_staged_audio(export: dict, content: bytes) -> Path:
    staged = export["workspaces"][0]["stagedAudio"]
    audio = Path(staged["path"])
    audio.write_bytes(content)
    staged["size"] = len(content)
    staged["sha256"] = hashlib.sha256(content).hexdigest()
    return audio


def test_an_unreadable_wav_names_the_file(tree) -> None:
    export, root, output = tree
    audio = _replace_staged_audio(export, b"not a wav at all" * 1000)
    with pytest.raises(TrainingExportError, match=re.escape(str(audio))) as info:
        build_dataset(export, root, output)
    assert "readable WAV" in str(info.value)


def test_a_region_past_the_end_of_the_wav_names_the_region(tree) -> None:
    export, root, output = tree
    source_path = root / f"corrections_{CATALOG}" / WORKSPACE / "source" / "transcript.json"
    source = _source()
    source["meta"]["generation_params"]["transcription_options"]["clip_timestamps"][2]["end"] = (
        30 * SR
    )
    source_text = json.dumps(source)
    source_path.write_text(source_text, encoding="utf-8")
    export["workspaces"][0]["sourceFingerprint"] = hashlib.sha256(
        source_text.encode("utf-8")
    ).hexdigest()
    audio = export["workspaces"][0]["stagedAudio"]["path"]
    with pytest.raises(TrainingExportError, match=re.escape(audio)) as info:
        build_dataset(export, root, output)
    assert "Region 2" in str(info.value) and "outside" in str(info.value)


def test_merging_piecewise_fetches_keeps_every_workspace(tree) -> None:
    export, _root, _output = tree
    other = {**export, "workspaces": [{**export["workspaces"][0], "workspaceId": "w2"}]}
    merged = merge_training_exports([export, other])
    assert [w["workspaceId"] for w in merged["workspaces"]] == [WORKSPACE, "w2"]
    assert merged["policy"] == export["policy"]
    with pytest.raises(TrainingExportError, match="different catalogs"):
        merge_training_exports([export, {**other, "catalogId": "20200101_000000"}])


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Ehm, tak hm jsme šli. Mhm.", "tak jsme šli."),
        ("hmotnost a hmyz", "hmotnost a hmyz"),
        ("eee… no jo", "no jo"),
        ("Ehm? Ano. Hm! Dobře. Mhm: tak", "Ano. Dobře. tak"),
        # A filler closing a sentence leaves the punctuation to the words before it.
        ("ano, hm?", "ano?"),
        ("ano, hm", "ano"),
        ("Tak jo, ehm. Dál.", "Tak jo. Dál."),
        # A filler opening a sentence takes its comma; the next word stays lowercase.
        ("Ehm, dobrý den.", "dobrý den."),
        ("(ehm) ano", "ano"),
        ('"hm" ano', "ano"),
        ("hm/mhm", ""),
        ("hmota", "hmota"),
        ("a-hm", "a-hm"),
    ],
)
def test_strip_fillers_removes_the_fixed_spellings_and_dangling_punctuation(
    text: str, expected: str
) -> None:
    assert strip_fillers(text) == expected


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
    policy = json.loads((latest / "dataset.json").read_text())["policy"]
    assert policy["test_recordings_source"] == str(DEFAULT_TEST_RECORDINGS_PATH)


def test_the_command_rejects_a_map_path_without_a_target(tree, tmp_path: Path, monkeypatch, capsys):
    from besedy.cli import catalog as catalog_cli

    export, root, output = tree
    export_file = tmp_path / "export.json"
    export_file.write_text(json.dumps(export), encoding="utf-8")
    monkeypatch.setattr(catalog_cli, "install_signal_handlers", lambda: None)

    argv = ["training-export", "--export-json", str(export_file), "--output-dir", str(output)]
    assert catalog_cli.main([*argv, "--corrections-root", str(root), "--map-path", "foo"]) == 1
    assert "FROM=TO" in capsys.readouterr().err
