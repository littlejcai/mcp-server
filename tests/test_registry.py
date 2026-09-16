import pytest

from pathlib import Path

from hub.registry import SkillRegistry


def _real_registry() -> SkillRegistry:
    root = Path(__file__).resolve().parent.parent
    return SkillRegistry(root / "registry.yaml", project_root=root)


def test_real_registry_loads():
    reg = _real_registry()
    ids = [s["id"] for s in reg.list()]
    assert "md-stats" in ids and "note-worthiness" in ids


def test_describe_hides_permissions():
    reg = _real_registry()
    d = reg.describe("md-stats")
    assert "permissions" not in d
    assert d["input_schema"]["properties"]["source_path"]


def test_unknown_skill_raises():
    reg = _real_registry()
    with pytest.raises(Exception):
        reg.get("nope")


def test_input_validation_rejects_missing_required():
    reg = _real_registry()
    with pytest.raises(ValueError, match="source_path"):
        reg.validate_inputs("md-stats", {"top_headings": 3})


def test_input_validation_accepts_valid():
    reg = _real_registry()
    reg.validate_inputs("md-stats", {"source_path": "inbox/a.md"})


def test_invalid_registry_rejected(tmp_path):
    bad = tmp_path / "registry.yaml"
    bad.write_text(
        "skills:\n  x:\n    name: X\n    typo_field: true\n", encoding="utf-8"
    )
    with pytest.raises(ValueError, match="typo_field"):
        SkillRegistry(bad, project_root=tmp_path)


def test_disabled_skill_hidden(tmp_path):
    f = tmp_path / "registry.yaml"
    f.write_text(
        "skills:\n"
        "  a:\n    name: A\n    description: d\n    type: script\n"
        "    enabled: false\n"
        "    runtime:\n      executable: python\n"
        "    input_schema: {type: object}\n",
        encoding="utf-8",
    )
    reg = SkillRegistry(f, project_root=tmp_path)
    assert reg.list() == []
