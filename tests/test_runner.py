"""Smoke tests that actually execute the script-type demo skill end to end."""

import asyncio
from pathlib import Path

import pytest

from hub.errors import SkillExecutionError, SkillInputError
from hub.registry import SkillRegistry
from hub.runner import ScriptRunner

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def runner(tmp_path):
    (tmp_path / "inbox").mkdir()
    (tmp_path / "inbox" / "a.md").write_text("# T\n\nhello world 内容\n" * 3, encoding="utf-8")
    (tmp_path / "output").mkdir()
    reg = SkillRegistry(ROOT / "registry.yaml", project_root=ROOT)
    return ScriptRunner(reg, tmp_path), tmp_path


def test_script_skill_success(runner):
    r, tmp = runner
    envelope = asyncio.run(
        r.run("md-stats", {"source_path": "inbox/a.md"}, dry_run=True, client="test")
    )
    assert envelope["status"] == "success"
    assert envelope["data"]["words"] == 12  # 3x heading "T" + 3x "hello world 内容"
    assert "duration_ms" in envelope


def test_script_skill_escape_path_rejected(runner):
    r, _ = runner
    with pytest.raises(SkillInputError):
        asyncio.run(r.run("md-stats", {"source_path": "inbox/../.."}))


def test_script_skill_missing_source_rejected(runner):
    # read-scope paths must exist: rejected by the hub before any process starts
    r, _ = runner
    with pytest.raises(SkillInputError, match="does not exist"):
        asyncio.run(r.run("md-stats", {"source_path": "inbox/nope.md"}))


def test_script_skill_dry_run_no_write(runner):
    r, tmp = runner
    envelope = asyncio.run(
        r.run(
            "md-stats",
            {"source_path": "inbox/a.md", "output_path": "output/report.md"},
            dry_run=True,
        )
    )
    assert not (tmp / "output" / "report.md").exists()
    assert envelope["artifacts"]


def test_timeout_raises(runner):
    r, _ = runner
    orig = r.registry.runtime

    def patched(sid):
        base = orig(sid)
        base["executable"] = "python"
        base["args"] = ["-c", "import time; time.sleep(30)"]
        base["timeout_seconds"] = 2
        return base

    r.registry.runtime = patched
    with pytest.raises(SkillExecutionError, match="timed out"):
        asyncio.run(r.run("md-stats", {"source_path": "inbox/a.md"}))
