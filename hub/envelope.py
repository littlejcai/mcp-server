"""Envelope contract shared by every skill, script and agent alike.

Request  (hub -> skill via stdin):  {"request_id", "action", "inputs", "context", "dry_run"}
Response (skill -> hub via stdout): {"status", "summary", "data", "artifacts", "warnings"}

The hub never needs to understand a skill's internals; it only moves envelopes.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

ENVELOPE_KEYS = ("status", "summary", "data", "artifacts", "warnings")

# In-band contract version, stamped by the hub on every request and response
# envelope (never taken from skill output). Kept in lockstep with the Node
# implementation (node/src/envelope.ts) — see docs/NODE-PLAN.md §并行期治理.
ENVELOPE_VERSION = 1


def build_request(
    skill_id: str,
    inputs: dict[str, Any],
    *,
    dry_run: bool = True,
    client: str = "",
) -> str:
    # multi-action convention: if the caller supplies inputs["action"], it is
    # mirrored into the envelope so skills can dispatch on it; it also stays
    # in inputs, so a skill may read it from either place.
    action = inputs.get("action", "run") if isinstance(inputs, dict) else "run"
    request = {
        "v": ENVELOPE_VERSION,
        "request_id": f"req_{uuid.uuid4().hex[:12]}",
        "action": action,
        "skill_id": skill_id,
        "inputs": inputs,
        "context": {"client": client},
        "dry_run": bool(dry_run),
    }
    return json.dumps(request, ensure_ascii=False)


_FENCED_JSON = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def parse_envelope(raw: str) -> dict[str, Any]:
    """Parse a skill response envelope, tolerating agent-style prose or fences."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("Skill produced no output")

    candidates: list[str] = [text]
    candidates += [m.group(1) for m in _FENCED_JSON.finditer(text)]
    # last balanced {...} block anywhere in the text (agents prepend chatter)
    start = text.rfind("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(text[start : i + 1])
                    break
        start = text.rfind("{", 0, start)

    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(data, dict) and "status" in data:
            return _normalize(data)
    raise ValueError(
        "Skill output did not contain a valid envelope "
        f"(expected JSON with a 'status' key); got: {text[:300]!r}"
    )


def _normalize(data: dict[str, Any]) -> dict[str, Any]:
    envelope: dict[str, Any] = {"v": ENVELOPE_VERSION}
    envelope.update({key: data.get(key) for key in ENVELOPE_KEYS})
    envelope["status"] = envelope["status"] or "error"
    envelope["summary"] = envelope["summary"] or ""
    envelope["data"] = envelope["data"] if isinstance(envelope["data"], dict) else {}
    envelope["artifacts"] = (
        envelope["artifacts"] if isinstance(envelope["artifacts"], list) else []
    )
    envelope["warnings"] = (
        envelope["warnings"] if isinstance(envelope["warnings"], list) else []
    )
    return envelope


def error_envelope(message: str) -> dict[str, Any]:
    return {
        "v": ENVELOPE_VERSION,
        "status": "error",
        "summary": message,
        "data": {},
        "artifacts": [],
        "warnings": [],
    }
