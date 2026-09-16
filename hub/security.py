"""Security primitives: path containment, subprocess environment, output sanitizing.

v1 honest threat model (no containers yet):
  - all file arguments are confined to the workspace by resolve()-based checks
  - subprocesses never see the full parent environment
  - command lines are always argv arrays, never shell strings
  - stderr/stdout are truncated and scrubbed before leaving the process

The ``permissions`` block in registry.yaml is *declarative intent*; the only
rules actually enforced in v1 are the ones in this module. Container isolation
is the roadmap item that turns the rest from documentation into enforcement.
"""

from __future__ import annotations

import re
from pathlib import Path

from .errors import SkillInputError

# Minimal environment every Windows child process needs to boot sanely.
WINDOWS_BASE_ENV = [
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
    "PROGRAMFILES",
    "COMMONPROGRAMFILES",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "OS",
]

# Extra entries the Claude Code CLI needs to locate its config/credentials.
AGENT_BASE_ENV = WINDOWS_BASE_ENV + [
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
]

_SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"gho_[A-Za-z0-9]{20,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._-]{8,}"),
    re.compile(r"(?i)(api[_-]?key|token|password|secret)\s*[=:]\s*\S+"),
]


class PathGuard:
    """Resolves untrusted path strings and confines them to allowed roots."""

    def __init__(self, workspace_root: str | Path):
        self.root = Path(workspace_root).resolve()

    def allowed_root(self, configured: str | Path) -> Path:
        """Resolve a registry-declared permission path against the workspace."""
        p = Path(configured)
        if not p.is_absolute():
            p = self.root / p
        return p.resolve()

    def resolve(
        self,
        value: str,
        *,
        allowed: list[str | Path] | None = None,
        must_exist: bool = False,
    ) -> Path:
        """Resolve ``value`` and require it to land inside one of ``allowed`` roots.

        Falls back to the whole workspace when ``allowed`` is omitted.
        Symlinks/junctions are handled by resolving first, then checking
        containment of the *final* target.
        """
        if not isinstance(value, str) or not value.strip():
            raise SkillInputError("Path argument must be a non-empty string")
        if "\x00" in value:
            raise SkillInputError("Path argument contains a null byte")

        roots = [self.allowed_root(r) for r in (allowed or ["."])]
        p = Path(value)
        if not p.is_absolute():
            p = self.root / p
        try:
            resolved = p.resolve()
        except OSError as exc:  # malformed names, illegal chars on Windows
            raise SkillInputError(f"Invalid path {value!r}: {exc}") from exc

        if not any(resolved == r or r in resolved.parents for r in roots):
            raise SkillInputError(
                f"Path {value!r} resolves outside the allowed workspace roots"
            )
        if must_exist and not resolved.exists():
            raise SkillInputError(f"Path {value!r} does not exist")
        return resolved


def build_env(allow: list[str], *, agent: bool = False) -> dict[str, str]:
    """Base (Windows or agent) environment plus an explicit per-skill allowlist."""
    base = AGENT_BASE_ENV if agent else WINDOWS_BASE_ENV
    names = dict.fromkeys([*base, *allow])
    return {name: value for name in names if (value := _os_environ().get(name))}


def _os_environ() -> dict[str, str]:
    import os

    return dict(os.environ)


def scrub(text: str, limit: int = 2000) -> str:
    """Truncate and mask anything that looks like a credential."""
    if not text:
        return ""
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    if len(text) > limit:
        text = text[:limit] + f"... [truncated {len(text) - limit} chars]"
    return text
