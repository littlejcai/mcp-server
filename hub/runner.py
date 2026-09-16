"""Script-type runner: fixed executable + argv array + stdin envelope.

Windows specifics handled here:
  - timeout kills the whole tree via ``taskkill /T /F`` (``process.kill()``
    only terminates the direct child and orphans grandchildren)
  - stdout/stderr go to temp files so a runaway process cannot exhaust
    memory; caps are applied when reading back
  - child gets a minimal environment, not ``os.environ``
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from .envelope import build_request, parse_envelope
from .errors import SkillExecutionError
from .registry import DEFAULT_MAX_STDOUT, DEFAULT_TIMEOUT, SkillRegistry
from .security import PathGuard, build_env, scrub


def resolve_executable(name: str) -> list[str]:
    """Turn a registry executable name into an argv prefix that CreateProcess accepts.

    npm-style shims (``claude.CMD`` etc.) are not directly launchable on
    Windows and go through ``cmd /c`` with their resolved path. Extension-less
    POSIX-style shims (``~/bin/python``) are equally unlaunchable but have no
    cmd equivalent, so we fall back to the bare name and let CreateProcess do
    its native PATH search.
    """
    if os.sep in name or (os.altsep and os.altsep in name):
        return [name]
    found = shutil.which(name)
    if found is None:
        return [name]
    lowered = found.lower()
    if lowered.endswith((".cmd", ".bat")):
        comspec = os.environ.get("COMSPEC", "cmd.exe")
        return [comspec, "/d", "/c", found]
    if lowered.endswith((".exe", ".com")):
        return [found]
    return [name]


class ScriptRunner:
    def __init__(self, registry: SkillRegistry, workspace_root: str | Path):
        self.registry = registry
        self.guard = PathGuard(workspace_root)

    async def run(
        self,
        skill_id: str,
        inputs: dict[str, Any],
        *,
        dry_run: bool = True,
        client: str = "",
    ) -> dict[str, Any]:
        runtime = self.registry.runtime(skill_id)
        permissions = self.registry.permissions(skill_id)
        timeout = runtime.get("timeout_seconds", DEFAULT_TIMEOUT)
        max_stdout = runtime.get("max_stdout_bytes", DEFAULT_MAX_STDOUT)

        inputs = self.confine_paths(skill_id, inputs)
        argv = [*resolve_executable(runtime["executable"]), *runtime.get("args", [])]
        request_body = build_request(skill_id, inputs, dry_run=dry_run, client=client)

        workdir = self._working_directory(runtime)
        env = build_env(
            permissions.get("environment", {}).get("allow", []),
        )

        started = time.monotonic()
        with tempfile.TemporaryFile() as out_file, tempfile.TemporaryFile() as err_file:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    cwd=str(workdir),
                    env=env,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=out_file,
                    stderr=err_file,
                )
            except FileNotFoundError as exc:
                raise SkillExecutionError(
                    f"Executable for skill {skill_id!r} not found: {argv[0]} ({exc})"
                ) from exc
            try:
                await asyncio.wait_for(
                    proc.communicate(request_body.encode("utf-8")), timeout=timeout
                )
            except asyncio.TimeoutError:
                self._kill_tree(proc)
                raise SkillExecutionError(
                    f"Skill {skill_id!r} timed out after {timeout}s and was killed"
                )

            if proc.returncode != 0:
                stderr_text = self._read_capped(err_file, 20_000)[0]
                raise SkillExecutionError(
                    f"Skill {skill_id!r} exited with code {proc.returncode}: "
                    f"{scrub(stderr_text)}"
                )

            stdout_text, truncated = self._read_capped(out_file, max_stdout)

        envelope = parse_envelope(stdout_text)
        if truncated:
            envelope["warnings"].append("stdout exceeded cap and was truncated")
        envelope["duration_ms"] = int((time.monotonic() - started) * 1000)
        return envelope

    def confine_paths(self, skill_id: str, inputs: dict[str, Any]) -> dict[str, Any]:
        """Resolve x-path-scope inputs and replace them with confined absolute paths.

        The skill never sees the caller's raw path string, only a path the hub
        has already proven to be inside the declared permission roots.
        """
        scopes = self.registry.path_scopes(skill_id)
        fs = self.registry.permissions(skill_id).get("filesystem", {})
        confined = dict(inputs)
        for key, scope in scopes.items():
            if key not in confined:
                continue
            roots = fs.get(scope, [])
            if not roots:
                raise SkillExecutionError(
                    f"Input {key!r} declares x-path-scope={scope!r} but the "
                    "registry lists no matching filesystem roots"
                )
            resolved = self.guard.resolve(
                str(confined[key]),
                allowed=roots,
                must_exist=(scope == "read"),
            )
            confined[key] = str(resolved)
        return confined

    def _working_directory(self, runtime: dict[str, Any]) -> Path:
        configured = runtime.get("working_directory")
        if not configured:
            return self.registry.project_root
        resolved = self.registry.resolve_project(configured)
        project_root = self.registry.project_root
        if (
            resolved != project_root
            and project_root not in resolved.parents
        ):
            raise SkillExecutionError(
                f"working_directory {configured!r} is outside the project root"
            )
        return resolved

    @staticmethod
    def _read_capped(fileobj, cap: int) -> tuple[str, bool]:
        fileobj.seek(0)
        data = fileobj.read(cap + 1)
        return data.decode("utf-8", errors="replace"), len(data) > cap

    @staticmethod
    def _kill_tree(proc: asyncio.subprocess.Process) -> None:
        """Terminate the whole child tree; plain kill() leaks grandchildren."""
        if proc.returncode is not None:
            return
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
        try:
            proc.kill()
        except ProcessLookupError:
            pass
