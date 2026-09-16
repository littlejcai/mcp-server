"""Append-only JSONL audit log — one line per skill invocation."""

from __future__ import annotations

import datetime as _dt
import json
import threading
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()


class AuditLog:
    def __init__(self, log_dir: str | Path):
        self.path = Path(log_dir) / "audit.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, **fields: Any) -> None:
        entry = {
            "ts": _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds"),
            **fields,
        }
        line = json.dumps(entry, ensure_ascii=False, default=str)
        with _LOCK, self.path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
