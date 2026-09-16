"""Agent-type runner: drive the local Claude Code CLI in headless mode.

Flow: MCP tool -> this runner -> ``claude -p`` -> the inner agent reads the
skill's SKILL.md, does the judgment work, and writes its final envelope to a
result file that we read back.

Honest limits in v1 (no container): the inner agent is constrained by
``--allowedTools`` (headless mode auto-denies anything not allow-listed), a
timeout + tree kill, and a minimal environment. For read-only skills this is
solid; give write-capable agent skills real isolation (sandbox/container)
before registering them.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from .envelope import parse_envelope
from .errors import SkillExecutionError
from .registry import DEFAULT_TIMEOUT, SkillRegistry
from .runner import ScriptRunner, resolve_executable
from .security import build_env, scrub

DEFAULT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Write"]
DEFAULT_MAX_TURNS = 20


class AgentRunner:
    def __init__(self, registry: SkillRegistry, workspace_root: str | Path):
        self.registry = registry
        self._script_runner = ScriptRunner(registry, workspace_root)
        self.guard = self._script_runner.guard

    async def run(
        self,
        skill_id: str,
        inputs: dict[str, Any],
        *,
        dry_run: bool = True,
        client: str = "",
    ) -> dict[str, Any]:
        runtime = self.registry.runtime(skill_id)
        if runtime.get("provider", "claude-code") != "claude-code":
            raise SkillExecutionError(
                f"Unsupported agent provider {runtime.get('provider')!r}"
            )

        skill_file = self.registry.resolve_project(
            runtime.get("skill_file") or self._default_skill_file(skill_id)
        )
        if not skill_file.is_file():
            raise SkillExecutionError(f"SKILL.md not found: {skill_file}")

        inputs = self._script_runner.confine_paths(skill_id, inputs)

        max_turns = runtime.get("max_turns", DEFAULT_MAX_TURNS)
        timeout = runtime.get("timeout_seconds", DEFAULT_TIMEOUT)
        allowed_tools = runtime.get("allowed_tools", DEFAULT_ALLOWED_TOOLS)

        with tempfile.TemporaryDirectory(
            dir=str(self.guard.root / "temp"), prefix="agent-"
        ) as temp_dir:
            result_path = Path(temp_dir) / "result.json"
            prompt = self._build_prompt(skill_id, skill_file, inputs, dry_run, result_path)

            # prompt travels via stdin: argv is short and immune to the
            # ~8k-char Windows command line limit and quoting hazards
            argv = [
                *resolve_executable(runtime["executable"]),
                "-p",
                "--output-format",
                "json",
                "--max-turns",
                str(max_turns),
                "--allowedTools",
                ",".join(allowed_tools),
            ]
            if runtime.get("model"):
                argv += ["--model", runtime["model"]]

            env = build_env(
                self.registry.permissions(skill_id)
                .get("environment", {})
                .get("allow", []),
                agent=True,
            )

            started = time.monotonic()
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    cwd=str(self.guard.root),
                    env=env,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
            except FileNotFoundError as exc:
                raise SkillExecutionError(
                    f"Agent CLI not found for skill {skill_id!r}: {argv[-1]} ({exc})"
                ) from exc
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(prompt.encode("utf-8")), timeout=timeout
                )
            except asyncio.TimeoutError:
                ScriptRunner._kill_tree(proc)
                raise SkillExecutionError(
                    f"Agent skill {skill_id!r} timed out after {timeout}s "
                    "(inner agent killed)"
                )

            if proc.returncode != 0:
                raise SkillExecutionError(
                    f"Agent CLI exited with code {proc.returncode}: "
                    f"{scrub(stderr.decode('utf-8', errors='replace'))}"
                )

            result_text = self._extract_cli_result(stdout.decode("utf-8", errors="replace"))
            raw = self._read_result_file(result_path)

        envelope = parse_envelope(raw if raw is not None else result_text)
        envelope["duration_ms"] = int((time.monotonic() - started) * 1000)
        return envelope

    def _build_prompt(
        self,
        skill_id: str,
        skill_file: Path,
        inputs: dict[str, Any],
        dry_run: bool,
        result_path: Path,
    ) -> str:
        request = {
            "request_id": f"req_{uuid.uuid4().hex[:12]}",
            "action": "run",
            "skill_id": skill_id,
            "inputs": inputs,
            "dry_run": bool(dry_run),
        }
        return (
            f"You are executing the registered skill \"{skill_id}\" inside skill-hub.\n"
            "First read the skill instructions at this exact path and follow them "
            f"precisely: {skill_file}\n\n"
            f"Workspace root (the only area you may touch): {self.guard.root}\n"
            "Request envelope:\n"
            f"{json.dumps(request, ensure_ascii=False)}\n\n"
            "Rules:\n"
            "- Stay inside the workspace root at all times.\n"
            "- Do not invent tools beyond the ones you have been given.\n"
            f"- As your FINAL action, write the response envelope JSON "
            '(keys: status, summary, data, artifacts, warnings) to '
            f"{result_path} using the Write tool. Write nothing else there."
        )

    @staticmethod
    def _extract_cli_result(cli_stdout: str) -> str:
        """``claude -p --output-format json`` wraps everything in its own JSON."""
        try:
            parsed = json.loads(cli_stdout)
            if isinstance(parsed, dict) and "result" in parsed:
                return str(parsed["result"])
        except json.JSONDecodeError:
            pass
        return cli_stdout

    @staticmethod
    def _read_result_file(result_path: Path) -> str | None:
        if result_path.is_file():
            try:
                return result_path.read_text(encoding="utf-8")
            except OSError:
                return None
        return None

    @staticmethod
    def _default_skill_file(skill_id: str) -> str:
        return f"skills/{skill_id}/SKILL.md"
