"""Registry loader: registry.yaml -> validated skill definitions."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema
import yaml

from .errors import UnknownSkillError

# Meta-schema every registry entry must satisfy. Keep strict: unknown
# runtime keys are rejected so typos fail loudly instead of silently
# disabling a limit.
SKILL_META_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["name", "description", "type", "runtime", "input_schema"],
    "additionalProperties": False,
    "properties": {
        "name": {"type": "string"},
        "description": {"type": "string"},
        "type": {"enum": ["script", "agent"]},
        "risk_level": {"enum": ["read_only", "workspace_write", "external_write"]},
        "first_class": {"type": "boolean"},
        "enabled": {"type": "boolean"},
        "runtime": {
            "type": "object",
            "required": ["executable"],
            "additionalProperties": False,
            "properties": {
                "executable": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}},
                "working_directory": {"type": "string"},
                "timeout_seconds": {"type": "integer", "minimum": 1},
                # script type
                "max_stdout_bytes": {"type": "integer", "minimum": 1},
                # agent type
                "provider": {"enum": ["claude-code"]},
                "skill_file": {"type": "string"},
                "model": {"type": "string"},
                "max_turns": {"type": "integer", "minimum": 1},
                "allowed_tools": {"type": "array", "items": {"type": "string"}},
            },
        },
        "input_schema": {"type": "object"},
        "permissions": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "filesystem": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "read": {"type": "array", "items": {"type": "string"}},
                        "write": {"type": "array", "items": {"type": "string"}},
                    },
                },
                "network": {"type": "boolean"},
                "environment": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "allow": {"type": "array", "items": {"type": "string"}},
                        "extra": {
                            "type": "object",
                            "additionalProperties": {"type": "string"},
                        },
                    },
                },
            },
        },
    },
}

DEFAULT_TIMEOUT = 180
DEFAULT_MAX_STDOUT = 100_000


class SkillRegistry:
    def __init__(self, registry_path: str | Path, project_root: str | Path):
        self.registry_path = Path(registry_path).resolve()
        self.project_root = Path(project_root).resolve()
        self.skills: dict[str, dict[str, Any]] = {}
        self.reload()

    def reload(self) -> None:
        data = yaml.safe_load(self.registry_path.read_text(encoding="utf-8")) or {}
        skills = data.get("skills", {})
        validator = jsonschema.Draft202012Validator(SKILL_META_SCHEMA)
        errors = []
        for skill_id, config in skills.items():
            for err in validator.iter_errors(config or {}):
                errors.append(f"{skill_id}: {err.message} (path: {list(err.path)})")
        if errors:
            raise ValueError(
                "registry.yaml is invalid:\n  - " + "\n  - ".join(errors)
            )
        self.skills = {
            skill_id: config
            for skill_id, config in skills.items()
            if config.get("enabled", True)
        }

    def list(self) -> list[dict[str, Any]]:
        """Public summary — no permission details leak here."""
        return [
            {
                "id": skill_id,
                "name": config["name"],
                "description": config["description"],
                "type": config["type"],
                "risk_level": config.get("risk_level", "unknown"),
            }
            for skill_id, config in self.skills.items()
        ]

    def get(self, skill_id: str) -> dict[str, Any]:
        if skill_id not in self.skills:
            raise UnknownSkillError(
                f"Unknown skill {skill_id!r}; call list_skills for the catalog"
            )
        return self.skills[skill_id]

    def describe(self, skill_id: str) -> dict[str, Any]:
        """Whitelisted view for describe_skill — config internals stay internal."""
        config = self.get(skill_id)
        return {
            "id": skill_id,
            "name": config["name"],
            "description": config["description"],
            "type": config["type"],
            "risk_level": config.get("risk_level", "unknown"),
            "input_schema": config["input_schema"],
            "timeout_seconds": config["runtime"].get(
                "timeout_seconds", DEFAULT_TIMEOUT
            ),
        }

    def runtime(self, skill_id: str) -> dict[str, Any]:
        return self.get(skill_id)["runtime"]

    def permissions(self, skill_id: str) -> dict[str, Any]:
        return self.get(skill_id).get("permissions", {})

    def path_scopes(self, skill_id: str) -> dict[str, str]:
        """Input properties annotated with x-path-scope: {prop: "read"|"write"}.

        ``x-`` keywords are invisible to JSON Schema validators; they are the
        contract that tells the hub which inputs are filesystem paths and
        which declared roots confine them.
        """
        properties = (self.get(skill_id)["input_schema"].get("properties")) or {}
        return {
            name: prop["x-path-scope"]
            for name, prop in properties.items()
            if prop.get("x-path-scope") in ("read", "write")
        }

    def validate_inputs(self, skill_id: str, inputs: dict[str, Any]) -> None:
        schema = self.get(skill_id)["input_schema"]
        validator = jsonschema.Draft202012Validator(schema)
        errors = sorted(validator.iter_errors(inputs), key=lambda e: list(e.path))
        if errors:
            details = "; ".join(
                f"{list(e.path) or ['inputs']}: {e.message}" for e in errors
            )
            raise ValueError(f"Input validation failed for {skill_id!r}: {details}")

    def resolve_project(self, relative: str) -> Path:
        """Resolve a registry-relative path (executable args, skill files)."""
        p = Path(relative)
        if not p.is_absolute():
            p = self.project_root / p
        return p.resolve()

    def first_class_ids(self) -> list[str]:
        return [
            skill_id
            for skill_id, config in self.skills.items()
            if config.get("first_class", False)
        ]

    def input_schema_json(self, skill_id: str) -> str:
        return json.dumps(self.get(skill_id)["input_schema"], ensure_ascii=False)
