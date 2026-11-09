"""Recording plans retain beam-stage dependencies and existing artifact policy."""

from __future__ import annotations

import pytest

from besedy.lib.workflow.common import CsvAudioRow
from besedy.lib.workflow.planning import plan_transcription
from tests.helpers.workflows import make_workflow_config


@pytest.mark.parametrize("segments_exist", [False, True])
@pytest.mark.parametrize("transcript_exists", [False, True])
@pytest.mark.parametrize("overwrite", [False, True])
def test_beam_stages_are_planned_for_the_same_recording(
    tmp_path, segments_exist, transcript_exists, overwrite
):
    config = make_workflow_config(workflow_id="canary-nemo-beam", decode_strategy="beam")
    audio_hash = "a" * 64
    directory = tmp_path / audio_hash
    directory.mkdir()
    for filename, exists in [
        ("nemo_beam_segments.json", segments_exist),
        ("transcript.json", transcript_exists),
    ]:
        if exists:
            (directory / filename).write_text("{}", encoding="utf-8")
    plans = plan_transcription(
        [CsvAudioRow(audio_hash, "audio.wav")], config, tmp_path, overwrite=overwrite
    )
    if not overwrite and segments_exist and transcript_exists:
        assert plans == []
    else:
        assert len(plans) == 1
        assert plans[0].audio_hash == audio_hash
        assert plans[0].transcribe == (overwrite or not segments_exist)
        assert plans[0].align == (overwrite or not transcript_exists)


@pytest.mark.parametrize("overwrite", [False, True])
def test_other_backends_plan_only_transcription(tmp_path, overwrite):
    config = make_workflow_config()
    rows = [CsvAudioRow(char * 64, f"{char}.wav") for char in "ab"]
    directory = tmp_path / rows[0].sha256
    directory.mkdir()
    (directory / "transcript.json").write_text("{}", encoding="utf-8")
    plans = plan_transcription(rows, config, tmp_path, overwrite=overwrite)
    assert [p.audio_hash for p in plans] == [
        row.sha256 for row in (rows if overwrite else rows[1:])
    ]
    assert all(p.transcribe and not p.align for p in plans)
