from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from besedy.lib.rag_eval_records import load_eval_records


def load_index_meta(index_dir: Path | str) -> dict[str, Any]:
    return json.loads((Path(index_dir) / "index_meta.json").read_text(encoding="utf-8"))


__all__ = ["load_eval_records", "load_index_meta"]
