"""Retirement is explicit, dry-run by default, and preserves live references."""

import json
import tomllib

import pytest

from scripts.retire_legacy_pipeline import main, without_retired_web_key


@pytest.mark.parametrize("value", ['"old"', '"""first\nsecond\n"""'])
def test_removes_only_the_retired_config_assignment(value):
    raw = f'[web]\nbase_url = "https://example.test"\ndeep_search_default_instructions = {value}\n\n[audio]\nsample_rate = 16000\n'
    updated = without_retired_web_key(raw)
    assert tomllib.loads(updated) == {
        "web": {"base_url": "https://example.test"},
        "audio": {"sample_rate": 16000},
    }
    assert updated == '[web]\nbase_url = "https://example.test"\n\n[audio]\nsample_rate = 16000\n'


def test_dry_run_changes_nothing_and_apply_invalidates_only_old_sidecars(tmp_path):
    old = tmp_path / "old.wav.audiohash"
    old.write_text("a" * 64 + "  old.wav\n")
    current = tmp_path / "current.wav.audiohash"
    current.write_text(
        "b" * 64 + "  current.wav\n"
        "# besedy-audio-hash-algorithm: pcm-s16le-16000hz-mono-sha256-v1\n"
        "# besedy-source-file-sha256: " + "c" * 64 + "\n"
    )
    assert main(["--sidecars-root", str(tmp_path)]) == 0
    assert old.exists() and current.exists()
    assert main(["--sidecars-root", str(tmp_path), "--apply"]) == 0
    assert not old.exists() and current.exists()


def test_retirement_refuses_current_references_before_any_mutation(tmp_path):
    active = tmp_path / "audio_catalog_20251222_144441.csv"
    active.write_text("current")
    references = tmp_path / "references.json"
    references.write_text(json.dumps([str(active)]))
    args = [
        "--retire-file",
        str(active),
        "--references-json",
        str(references),
        "--retired-dir",
        str(tmp_path / "retired"),
        "--apply",
    ]
    with pytest.raises(SystemExit, match="1"):
        main(args)
    assert active.read_text() == "current"
    assert not (tmp_path / "retired").exists()


def test_retirement_moves_only_explicit_unreferenced_files(tmp_path):
    obsolete = tmp_path / "audio_catalog_merged_v2.csv"
    obsolete.write_text("old")
    references = tmp_path / "references.json"
    references.write_text("[]")
    args = [
        "--retire-file",
        str(obsolete),
        "--references-json",
        str(references),
        "--retired-dir",
        str(tmp_path / "retired"),
    ]
    assert main(args) == 0
    assert obsolete.exists()
    assert main([*args, "--apply"]) == 0
    assert not obsolete.exists()
    assert (tmp_path / "retired" / obsolete.name).read_text() == "old"


def test_retirement_destination_must_be_disjoint_from_active_artifacts(tmp_path):
    obsolete = tmp_path / "audio_catalog_merged_v2.csv"
    obsolete.write_text("old")
    active = tmp_path / "transcripts_20251222_144441"
    active.mkdir()
    references = tmp_path / "references.json"
    references.write_text(json.dumps([str(active)]))
    with pytest.raises(SystemExit, match="1"):
        main(
            [
                "--retire-file",
                str(obsolete),
                "--references-json",
                str(references),
                "--retired-dir",
                str(active / "retired"),
                "--apply",
            ]
        )
    assert obsolete.exists()
    assert not (active / "retired").exists()
