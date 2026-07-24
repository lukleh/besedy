from __future__ import annotations

from besedy.lib.rag_retrieval_providers import TEIRerankerProvider


def test_tei_reranker_provider_prefers_rag_rerank_url(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_post_json(url: str, *, payload: object, timeout_seconds: float):
        captured["url"] = url
        captured["payload"] = payload
        captured["timeout_seconds"] = timeout_seconds
        return [{"index": 0, "score": 0.5}]

    monkeypatch.setattr("besedy.lib.rag_retrieval_providers._http_post_json", fake_post_json)
    monkeypatch.setenv("RAG_RERANK_URL", "http://localhost:9191/v1/rerank")
    monkeypatch.setenv("RAG_TEI_RERANK_URL", "http://localhost:8191/rerank")

    provider = TEIRerankerProvider(batch_size=1)
    scores = provider.score(query="komunitni zahrada", texts=["plan zalevani"])

    assert captured["url"] == "http://localhost:9191/v1/rerank"
    assert captured["payload"] == {
        "query": "komunitni zahrada",
        "texts": ["plan zalevani"],
    }
    assert captured["timeout_seconds"] == 30.0
    assert scores.tolist() == [0.5]
