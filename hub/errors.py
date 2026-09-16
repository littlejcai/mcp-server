"""Shared exception types for skill-hub."""


class SkillHubError(Exception):
    """Base error for skill-hub."""


class UnknownSkillError(SkillHubError):
    """Raised when a skill id is not present in the registry."""


class SkillInputError(SkillHubError):
    """Raised when inputs fail validation (schema or path safety)."""


class SkillExecutionError(SkillHubError):
    """Raised when a skill process fails, times out, or misbehaves."""
