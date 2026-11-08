"""The pipeline, host worker and web reader agree on catalog generations."""

import json
from pathlib import Path

import pytest

from besedy.core.paths import catalog_transcripts_dirname, resolve_transcripts_parent

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[1] / "contracts/catalog-transcript-paths.json").read_text()
)


@pytest.mark.parametrize("case", CONTRACT["generations"])
def test_catalog_generation_matches_web_contract(case):
    assert catalog_transcripts_dirname(case["catalogId"]) == case["directory"]


@pytest.mark.parametrize("catalog_id", CONTRACT["invalidCatalogIds"])
def test_invalid_catalog_generation_is_refused(catalog_id):
    with pytest.raises(ValueError, match="catalog ID"):
        catalog_transcripts_dirname(catalog_id)


def test_transcript_parent_matches_web_contract(tmp_path, monkeypatch):
    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path))
    assert resolve_transcripts_parent() == tmp_path / CONTRACT["parent"]
