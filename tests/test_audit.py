import json

from hub.audit import AuditLog


def test_record_appends_jsonl(tmp_path):
    log = AuditLog(tmp_path)
    log.record(skill_id="md-stats", status="success", duration_ms=5)
    log.record(skill_id="note-worthiness", status="failed", reason="boom")

    lines = (tmp_path / "audit.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["skill_id"] == "md-stats"
    assert "ts" in first  # ISO timestamp injected


def test_unicode_survives(tmp_path):
    log = AuditLog(tmp_path)
    log.record(skill_id="素材", status="success", reason="中文内容")
    entry = json.loads((tmp_path / "audit.jsonl").read_text(encoding="utf-8"))
    assert entry["reason"] == "中文内容"
