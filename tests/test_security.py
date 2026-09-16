import pytest

from hub.security import PathGuard, build_env, scrub
from hub.errors import SkillInputError


@pytest.fixture
def guard(tmp_path):
    (tmp_path / "inbox").mkdir()
    (tmp_path / "inbox" / "a.md").write_text("hello", encoding="utf-8")
    return PathGuard(tmp_path)


def test_relative_path_confined(guard):
    p = guard.resolve("inbox/a.md", must_exist=True)
    assert p.is_file()


def test_absolute_inside_ok(guard, tmp_path):
    p = guard.resolve(str(tmp_path / "inbox" / "a.md"))
    assert p.name == "a.md"


def test_traversal_escape_rejected(guard):
    with pytest.raises(SkillInputError):
        guard.resolve("inbox/../../outside.md")


def test_absolute_outside_rejected(guard):
    with pytest.raises(SkillInputError):
        guard.resolve("C:/Windows/system32/drivers/etc/hosts")


def test_null_byte_rejected(guard):
    with pytest.raises(SkillInputError):
        guard.resolve("inbox/a.md\x00.txt")


def test_missing_file_rejected_when_required(guard):
    with pytest.raises(SkillInputError):
        guard.resolve("inbox/nope.md", must_exist=True)


def test_custom_allowed_roots(guard):
    p = guard.resolve("inbox/a.md", allowed=["inbox"])
    assert p.is_file()
    with pytest.raises(SkillInputError):
        guard.resolve("other/x.md", allowed=["inbox"])


def test_build_env_excludes_secrets(monkeypatch):
    monkeypatch.setenv("MY_API_KEY", "sk-abcdef123456")
    monkeypatch.setenv("SYSTEMROOT", "C:\\Windows")
    env = build_env(["PATH"])
    assert "MY_API_KEY" not in env
    assert "PATH" in env
    assert "SYSTEMROOT" in env  # Windows base env survives


def test_scrub_masks_secrets():
    text = "failed with key sk-abcdef123456789 and Bearer abc.def.ghi-jkl"
    out = scrub(text)
    assert "sk-abcdef" not in out
    assert "[REDACTED]" in out


def test_scrub_truncates():
    assert scrub("x" * 5000, limit=100).endswith("chars]")
