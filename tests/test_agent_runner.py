"""Agent runner tests with a mocked subprocess layer.

No real Claude CLI is spawned here; ``asyncio.create_subprocess_exec`` is
replaced by a fake that simulates the CLI contract (result file, json stdout,
exit codes, hangs). The real end-to-end behavior is verified separately by the
live smoke test; these tests pin down every failure branch.
"""

import asyncio
import json
import re
from pathlib import Path

import pytest

import hub.agent_runner as agent_runner
from hub.agent_runner import AgentRunner
from hub.errors import SkillExecutionError, SkillInputError
from hub.registry import SkillRegistry

ROOT = Path(__file__).resolve().parent.parent

ENVELOPE = {
    "status": "success",
    "summary": "值得写",
    "data": {"verdict": "strong"},
    "artifacts": [],
    "warnings": [],
}


class FakeProc:
    def __init__(self, *, stdout=b"", stderr=b"", returncode=0, delay=0.0,
                 write_result=False):
        self.pid = 424242
        self._stdout = stdout
        self._stderr = stderr
        self.returncode = None if delay else returncode
        self._delay = delay
        self._write_result = write_result
        self.killed = False

    async def communicate(self, stdin: bytes = b""):
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._write_result:
            match = re.search(r"to (\S+result\.json) using", stdin.decode("utf-8"))
            assert match, "prompt did not contain the result file path"
            Path(match.group(1)).write_text(
                json.dumps(ENVELOPE, ensure_ascii=False), encoding="utf-8"
            )
        return self._stdout, self._stderr

    def kill(self):
        self.killed = True
        self.returncode = 1


@pytest.fixture
def runner(tmp_path):
    (tmp_path / "inbox").mkdir()
    (tmp_path / "inbox" / "sample-note.md").write_text(
        "hello world", encoding="utf-8"
    )
    (tmp_path / "temp").mkdir()  # AgentRunner stages result files here
    registry = SkillRegistry(ROOT / "registry.yaml", project_root=ROOT)
    return AgentRunner(registry, tmp_path)


def _patch_runtime(monkeypatch, runner: AgentRunner, **overrides):
    orig = runner.registry.runtime

    def patched(skill_id):
        base = dict(orig(skill_id))
        base.update(overrides)
        return base

    monkeypatch.setattr(runner.registry, "runtime", patched)


def _patch_spawn(monkeypatch, proc: FakeProc | Exception):
    calls = []

    async def fake_exec(*argv, **kwargs):
        calls.append(argv)
        if isinstance(proc, Exception):
            raise proc
        return proc

    monkeypatch.setattr(agent_runner.asyncio, "create_subprocess_exec", fake_exec)
    return calls


def test_success_via_result_file(monkeypatch, runner):
    cli_json = json.dumps({"result": "prose the agent printed", "is_error": False})
    proc = FakeProc(stdout=cli_json.encode(), write_result=True)
    _patch_spawn(monkeypatch, proc)

    envelope = asyncio.run(
        runner.run("note-worthiness", {"note_path": "inbox/sample-note.md"})
    )
    assert envelope["status"] == "success"
    assert envelope["data"]["verdict"] == "strong"
    assert envelope["summary"] == "值得写"
    assert proc.killed is False


def test_falls_back_to_cli_result_text(monkeypatch, runner):
    """No result file: envelope is recovered from the CLI's result prose."""
    fallback = "分析完成。\n```json\n" + json.dumps(ENVELOPE, ensure_ascii=False) + "\n```"
    cli_json = json.dumps({"result": fallback})
    _patch_spawn(monkeypatch, FakeProc(stdout=cli_json.encode()))

    envelope = asyncio.run(
        runner.run("note-worthiness", {"note_path": "inbox/sample-note.md"})
    )
    assert envelope["status"] == "success"
    assert envelope["data"]["verdict"] == "strong"


def test_nonzero_exit_raises_with_scrubbed_stderr(monkeypatch, runner):
    proc = FakeProc(
        returncode=3,
        stderr=b"panic: token sk-abcdef123456 leaked",
        stdout=b"",
    )
    _patch_spawn(monkeypatch, proc)
    with pytest.raises(SkillExecutionError, match="code 3") as excinfo:
        asyncio.run(
            runner.run("note-worthiness", {"note_path": "inbox/sample-note.md"})
        )
    # scrubbing happens before the error leaves the process
    assert "[REDACTED]" in str(excinfo.value)
    assert "sk-abcdef123456" not in str(excinfo.value)


def test_timeout_kills_process_tree(monkeypatch, runner):
    _patch_runtime(monkeypatch, runner, timeout_seconds=1)
    proc = FakeProc(stdout=b"{}", delay=5.0)
    _patch_spawn(monkeypatch, proc)

    with pytest.raises(SkillExecutionError, match="timed out"):
        asyncio.run(
            runner.run("note-worthiness", {"note_path": "inbox/sample-note.md"})
        )
    assert proc.killed is True


def test_missing_cli_raises_clear_error(monkeypatch, runner):
    _patch_spawn(monkeypatch, FileNotFoundError("claude not on PATH"))

    with pytest.raises(SkillExecutionError, match="Agent CLI not found"):
        asyncio.run(
            runner.run("note-worthiness", {"note_path": "inbox/sample-note.md"})
        )


def test_unsupported_provider_rejected(monkeypatch, runner):
    _patch_runtime(monkeypatch, runner, provider="codex")
    calls = _patch_spawn(monkeypatch, FakeProc())

    with pytest.raises(SkillExecutionError, match="provider"):
        asyncio.run(
            runner.run("note-worthiness", {"note_path": "inbox/sample-note.md"})
        )
    assert calls == []  # never spawned


def test_missing_skill_file_rejected(monkeypatch, runner):
    _patch_runtime(monkeypatch, runner, skill_file="skills/nope/SKILL.md")
    calls = _patch_spawn(monkeypatch, FakeProc())

    with pytest.raises(SkillExecutionError, match="SKILL.md not found"):
        asyncio.run(
            runner.run("note-worthiness", {"note_path": "inbox/sample-note.md"})
        )
    assert calls == []


def test_escape_path_rejected_before_spawn(monkeypatch, runner):
    calls = _patch_spawn(monkeypatch, FakeProc())

    with pytest.raises(SkillInputError, match="outside the allowed workspace"):
        asyncio.run(
            runner.run("note-worthiness", {"note_path": "../../secrets.token"})
        )
    assert calls == []


def test_extract_cli_result_variants():
    plain = agent_runner.AgentRunner._extract_cli_result('{"result": "R", "x": 1}')
    assert plain == "R"
    non_json = agent_runner.AgentRunner._extract_cli_result("plain output")
    assert non_json == "plain output"


def test_read_result_file_missing_returns_none(tmp_path):
    assert AgentRunner._read_result_file(tmp_path / "nope.json") is None
