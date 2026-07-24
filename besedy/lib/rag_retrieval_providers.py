"""Embedding/reranking providers for transcript-only RAG retrieval."""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

import numpy as np

from .rag_retrieval_chunking import _tokenize


def _to_float32_normalized(vectors: np.ndarray) -> np.ndarray:
    if vectors.size == 0:
        return vectors.astype(np.float32)
    arr = vectors.astype(np.float32, copy=False)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms = np.where(norms == 0.0, 1.0, norms)
    return arr / norms


class EmbeddingProvider:
    """Protocol-like base class for dense embeddings."""

    def embed(self, texts: list[str]) -> np.ndarray:
        raise NotImplementedError

    @property
    def name(self) -> str:
        raise NotImplementedError

    @property
    def model(self) -> str:
        raise NotImplementedError


class RerankerProvider:
    """Protocol-like base class for reranking query-document pairs."""

    def score(self, *, query: str, texts: list[str]) -> np.ndarray:
        raise NotImplementedError

    @property
    def name(self) -> str:
        raise NotImplementedError

    @property
    def model(self) -> str:
        raise NotImplementedError


class HashingEmbeddingProvider(EmbeddingProvider):
    """Deterministic local fallback embedding provider."""

    def __init__(self, dim: int = 768) -> None:
        if dim <= 0:
            raise ValueError("Embedding dimension must be positive.")
        self._dim = dim

    @property
    def name(self) -> str:
        return "hash"

    @property
    def model(self) -> str:
        return f"hashing-{self._dim}"

    def embed(self, texts: list[str]) -> np.ndarray:
        matrix = np.zeros((len(texts), self._dim), dtype=np.float32)
        for row, text in enumerate(texts):
            tokens = _tokenize(text)
            if not tokens:
                continue
            for token in tokens:
                digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
                val = int.from_bytes(digest, byteorder="little", signed=False)
                idx = val % self._dim
                sign = 1.0 if ((val >> 63) & 1) == 0 else -1.0
                matrix[row, idx] += sign
        return _to_float32_normalized(matrix)


class BgeM3EmbeddingProvider(EmbeddingProvider):
    """Local dense embedding provider based on transformers AutoModel."""

    def __init__(
        self,
        *,
        model_name: str = "BAAI/bge-m3",
        batch_size: int = 16,
        max_length: int = 1024,
        device: str | None = None,
    ) -> None:
        if batch_size <= 0:
            raise ValueError("batch_size must be positive.")
        if max_length <= 0:
            raise ValueError("max_length must be positive.")

        try:
            import torch
            from transformers import AutoModel, AutoTokenizer
        except ImportError as exc:
            raise ImportError(
                "transformers + torch are required for bge-m3 embeddings. "
                "Install dependencies with `uv sync`."
            ) from exc

        self._torch = torch
        self._batch_size = batch_size
        self._max_length = max_length
        self._model_name = model_name
        self._tokenizer = AutoTokenizer.from_pretrained(model_name)
        self._model = AutoModel.from_pretrained(model_name)
        if device is None:
            self._device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            self._device = device
        self._model.to(self._device)
        self._model.eval()

    @property
    def name(self) -> str:
        return "bge-m3"

    @property
    def model(self) -> str:
        return self._model_name

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, 0), dtype=np.float32)

        outputs: list[np.ndarray] = []
        if not callable(self._tokenizer):
            raise RuntimeError(f"Tokenizer for {self._model_name} is not callable.")
        torch = self._torch
        with torch.no_grad():
            for i in range(0, len(texts), self._batch_size):
                batch = texts[i : i + self._batch_size]
                encoded = self._tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    max_length=self._max_length,
                    return_tensors="pt",
                )
                encoded = {key: value.to(self._device) for key, value in encoded.items()}

                model_output = self._model(**encoded)
                token_embeddings = model_output.last_hidden_state
                attention_mask = (
                    encoded["attention_mask"].unsqueeze(-1).expand(token_embeddings.shape)
                )
                masked = token_embeddings * attention_mask.float()
                summed = masked.sum(dim=1)
                counts = attention_mask.sum(dim=1).clamp(min=1e-9)
                mean_pooled = summed / counts
                normalized = torch.nn.functional.normalize(mean_pooled, p=2, dim=1)
                outputs.append(normalized.cpu().numpy().astype(np.float32))

        return np.vstack(outputs)


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """OpenAI embeddings provider."""

    def __init__(self, *, model_name: str = "text-embedding-3-large", batch_size: int = 64) -> None:
        if batch_size <= 0:
            raise ValueError("batch_size must be positive.")
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise ImportError(
                "openai package is required for OpenAI embeddings. Install dependencies with `uv sync`."
            ) from exc
        self._model_name = model_name
        self._batch_size = batch_size
        self._client = OpenAI()

    @property
    def name(self) -> str:
        return "openai"

    @property
    def model(self) -> str:
        return self._model_name

    def embed(self, texts: list[str]) -> np.ndarray:
        vectors: list[list[float]] = []
        for i in range(0, len(texts), self._batch_size):
            batch = texts[i : i + self._batch_size]
            response = self._client.embeddings.create(model=self._model_name, input=batch)
            vectors.extend(item.embedding for item in response.data)
        return _to_float32_normalized(np.array(vectors, dtype=np.float32))


def _http_post_json(url: str, payload: dict[str, Any], timeout_seconds: float) -> Any:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib_request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} from {url}: {detail[:400]}") from exc
    except urllib_error.URLError as exc:
        raise RuntimeError(f"Failed to reach {url}: {exc.reason}") from exc
    except TimeoutError as exc:
        raise RuntimeError(f"Request timed out calling {url}") from exc

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON from {url}: {body[:400]}") from exc


class TEIEmbeddingProvider(EmbeddingProvider):
    """Embedding provider backed by TEI HTTP endpoint."""

    def __init__(
        self,
        *,
        model_name: str = "Qwen/Qwen3-Embedding-0.6B",
        endpoint_url: str | None = None,
        batch_size: int = 1,
        timeout_seconds: float = 30.0,
    ) -> None:
        if batch_size <= 0:
            raise ValueError("batch_size must be positive.")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive.")

        self._model_name = model_name
        self._endpoint_url = (
            endpoint_url
            or os.getenv("RAG_TEI_EMBED_URL")
            or os.getenv("TEI_EMBED_URL")
            or "http://127.0.0.1:8190/v1/embeddings"
        )
        self._batch_size = batch_size
        self._timeout_seconds = timeout_seconds

    @property
    def name(self) -> str:
        return "tei"

    @property
    def model(self) -> str:
        return self._model_name

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, 0), dtype=np.float32)

        vectors: list[list[float]] = []
        for i in range(0, len(texts), self._batch_size):
            batch = texts[i : i + self._batch_size]
            payload = {
                "input": batch,
                "model": self._model_name,
            }
            response = _http_post_json(
                self._endpoint_url,
                payload=payload,
                timeout_seconds=self._timeout_seconds,
            )
            if isinstance(response, dict) and isinstance(response.get("data"), list):
                for item in response["data"]:
                    if not isinstance(item, dict) or not isinstance(item.get("embedding"), list):
                        raise RuntimeError("Unexpected TEI embeddings payload shape.")
                    vectors.append([float(x) for x in item["embedding"]])
                continue

            if isinstance(response, list):
                for item in response:
                    if not isinstance(item, list):
                        raise RuntimeError("Unexpected TEI /embed payload shape.")
                    vectors.append([float(x) for x in item])
                continue

            raise RuntimeError("Unsupported TEI embeddings response payload.")

        return _to_float32_normalized(np.array(vectors, dtype=np.float32))


class BgeRerankerProvider(RerankerProvider):
    """Local cross-encoder reranker based on transformers sequence classification."""

    def __init__(
        self,
        *,
        model_name: str = "BAAI/bge-reranker-v2-m3",
        batch_size: int = 8,
        max_length: int = 512,
        device: str | None = None,
    ) -> None:
        if batch_size <= 0:
            raise ValueError("batch_size must be positive.")
        if max_length <= 0:
            raise ValueError("max_length must be positive.")

        try:
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer
        except ImportError as exc:
            raise ImportError(
                "transformers + torch are required for bge reranker. "
                "Install dependencies with `uv sync`."
            ) from exc

        self._torch = torch
        self._batch_size = batch_size
        self._max_length = max_length
        self._model_name = model_name
        self._tokenizer = AutoTokenizer.from_pretrained(model_name)
        self._model = AutoModelForSequenceClassification.from_pretrained(model_name)
        if device is None:
            self._device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            self._device = device
        self._model.to(self._device)
        self._model.eval()

    @property
    def name(self) -> str:
        return "bge-reranker"

    @property
    def model(self) -> str:
        return self._model_name

    def score(self, *, query: str, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0,), dtype=np.float32)

        outputs: list[np.ndarray] = []
        if not callable(self._tokenizer):
            raise RuntimeError(f"Tokenizer for {self._model_name} is not callable.")
        torch = self._torch
        with torch.no_grad():
            for i in range(0, len(texts), self._batch_size):
                batch_texts = texts[i : i + self._batch_size]
                pairs = [[query, text] for text in batch_texts]
                encoded = self._tokenizer(
                    pairs,
                    padding=True,
                    truncation=True,
                    max_length=self._max_length,
                    return_tensors="pt",
                )
                encoded = {key: value.to(self._device) for key, value in encoded.items()}

                logits = self._model(**encoded).logits
                if logits.ndim == 2 and logits.shape[1] > 1:
                    logits = logits[:, 0]
                else:
                    logits = logits.view(-1)
                outputs.append(logits.detach().cpu().numpy().astype(np.float32))

        return np.concatenate(outputs, axis=0)


class TEIRerankerProvider(RerankerProvider):
    """Reranker provider backed by TEI /rerank endpoint."""

    def __init__(
        self,
        *,
        model_name: str = "Alibaba-NLP/gte-multilingual-reranker-base",
        endpoint_url: str | None = None,
        batch_size: int = 64,
        timeout_seconds: float = 30.0,
    ) -> None:
        if batch_size <= 0:
            raise ValueError("batch_size must be positive.")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive.")

        self._model_name = model_name
        self._endpoint_url = (
            endpoint_url
            or os.getenv("RAG_RERANK_URL")
            or os.getenv("RAG_TEI_RERANK_URL")
            or os.getenv("TEI_RERANK_URL")
            or "http://127.0.0.1:8191/rerank"
        )
        self._batch_size = batch_size
        self._timeout_seconds = timeout_seconds

    @property
    def name(self) -> str:
        return "tei-reranker"

    @property
    def model(self) -> str:
        return self._model_name

    def score(self, *, query: str, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0,), dtype=np.float32)

        output_scores: list[np.ndarray] = []
        for i in range(0, len(texts), self._batch_size):
            batch = texts[i : i + self._batch_size]
            payload = {"query": query, "texts": batch}
            response = _http_post_json(
                self._endpoint_url,
                payload=payload,
                timeout_seconds=self._timeout_seconds,
            )

            if not isinstance(response, list):
                raise RuntimeError("Unexpected TEI rerank response payload.")

            batch_scores = np.zeros((len(batch),), dtype=np.float32)
            for item in response:
                if not isinstance(item, dict):
                    raise RuntimeError("Unexpected TEI rerank item payload.")
                idx = item.get("index")
                score = item.get("score")
                if not isinstance(idx, int) or not (0 <= idx < len(batch)):
                    raise RuntimeError("Invalid TEI rerank index in response.")
                if not isinstance(score, (int, float)):
                    raise RuntimeError("Invalid TEI rerank score in response.")
                batch_scores[idx] = float(score)
            output_scores.append(batch_scores)

        return np.concatenate(output_scores, axis=0)


def _make_embedding_provider(
    *,
    provider: str,
    model: str | None,
    batch_size: int,
    device: str | None,
) -> EmbeddingProvider:
    normalized = provider.strip().lower()
    if normalized == "hash":
        return HashingEmbeddingProvider()
    if normalized == "tei":
        return TEIEmbeddingProvider(
            model_name=model or "Qwen/Qwen3-Embedding-0.6B",
            batch_size=batch_size,
        )
    if normalized == "bge-m3":
        return BgeM3EmbeddingProvider(
            model_name=model or "BAAI/bge-m3",
            batch_size=batch_size,
            device=device,
        )
    if normalized == "openai":
        return OpenAIEmbeddingProvider(
            model_name=model or "text-embedding-3-large",
            batch_size=batch_size,
        )
    raise ValueError(f"Unknown embedding provider: {provider!r}")


def _make_reranker_provider(
    *,
    provider: str | None,
    model: str | None,
    batch_size: int,
    device: str | None,
    max_length: int,
) -> RerankerProvider | None:
    normalized = (provider or "").strip().lower()
    if normalized in {"", "none", "off", "false", "0"}:
        return None
    if normalized == "bge-reranker":
        return BgeRerankerProvider(
            model_name=model or "BAAI/bge-reranker-v2-m3",
            batch_size=batch_size,
            max_length=max_length,
            device=device,
        )
    if normalized in {"tei-reranker", "tei"}:
        return TEIRerankerProvider(
            model_name=model or "Alibaba-NLP/gte-multilingual-reranker-base",
            batch_size=batch_size,
        )
    raise ValueError(f"Unknown reranker provider: {provider!r}")
