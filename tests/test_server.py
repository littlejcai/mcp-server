"""Server-layer tests: in-memory MCP client for tools, ASGI TestClient for
auth middleware, and a serialization check on the global concurrency limit.
"""

import asyncio
import time

import pytest
from starlette.testclient import TestClient

import server
from fastmcp import Client
from fastmcp.exceptions import ToolError

TOKEN = server.AUTH_TOKEN


# --------------------------------------------------------------------------
# tool surface (in-memory transport; HTTP auth is tested further below)
# --------------------------------------------------------------------------

def test_list_skills_over_mcp():
    async def go():
        async with Client(server.mcp) as c:
            result = await c.call_tool("list_skills", {})
            return result.data

    skills = asyncio.run(go())
    assert {s["id"] for s in skills} == {"md-stats", "note-worthiness"}


def test_describe_unknown_skill_is_tool_error():
    async def go():
        async with Client(server.mcp) as c:
            await c.call_tool("describe_skill", {"skill_id": "nope"})

    with pytest.raises(ToolError, match="Unknown skill"):
        asyncio.run(go())


def test_run_unknown_skill_is_tool_error():
    async def go():
        async with Client(server.mcp) as c:
            await c.call_tool("run_skill", {"skill_id": "nope", "inputs": {}})

    with pytest.raises(ToolError, match="Unknown skill"):
        asyncio.run(go())


def test_run_schema_violation_is_tool_error():
    async def go():
        async with Client(server.mcp) as c:
            await c.call_tool("run_skill", {"skill_id": "md-stats", "inputs": {}})

    with pytest.raises(ToolError, match="Input validation failed"):
        asyncio.run(go())


def test_run_path_escape_is_tool_error():
    async def go():
        async with Client(server.mcp) as c:
            await c.call_tool(
                "run_skill",
                {"skill_id": "md-stats", "inputs": {"source_path": "../../etc"}},
            )

    with pytest.raises(ToolError, match="outside the allowed workspace"):
        asyncio.run(go())


def test_run_skill_success_in_memory():
    async def go():
        async with Client(server.mcp) as c:
            result = await c.call_tool(
                "run_skill",
                {
                    "skill_id": "md-stats",
                    "inputs": {"source_path": "inbox/sample-note.md"},
                },
            )
            return result.data

    envelope = asyncio.run(go())
    assert envelope["status"] == "success"
    assert envelope["data"]["words"] == 32


# --------------------------------------------------------------------------
# HTTP auth middleware
#
# Note: deliberately NO lifespan (no `with TestClient(...)`). Starting the
# streamable-http session manager under TestClient leaks its task group on
# Windows and pytest never exits. The middleware sits in front of the app,
# so 401 behavior needs no lifespan; the full authenticated MCP flow over
# HTTP is verified live by tests/thirdparty/verify_remote.mjs.
# --------------------------------------------------------------------------

@pytest.fixture(scope="module")
def http_client():
    client = TestClient(server.build_app(), raise_server_exceptions=False)
    yield client
    client.close()


def test_health_needs_no_token(http_client):
    response = http_client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_mcp_without_token_is_401(http_client):
    assert http_client.get("/mcp").status_code == 401


def test_mcp_with_wrong_token_is_401(http_client):
    response = http_client.get(
        "/mcp", headers={"Authorization": "Bearer wrong-token"}
    )
    assert response.status_code == 401


def test_mcp_with_correct_token_passes_auth(http_client):
    response = http_client.get("/mcp", headers={"Authorization": f"Bearer {TOKEN}"})
    # auth accepted; without lifespan the handler answers 500 — the point is
    # the request got past the middleware and is not its 401
    assert response.status_code != 401


# --------------------------------------------------------------------------
# global concurrency limit
# --------------------------------------------------------------------------

def test_global_semaphore_serializes_executions(monkeypatch):
    """No real subprocess: the property under test is the semaphore, not the
    runner. (Real in-loop subprocess pairs trigger an asyncio.run cleanup
    hang on Windows Proactor, which is out of scope here.)"""
    active = {"n": 0}
    max_active = {"n": 0}

    async def fake_run(skill_id, inputs, *, dry_run=True, client=""):
        active["n"] += 1
        max_active["n"] = max(max_active["n"], active["n"])
        await asyncio.sleep(0.3)
        active["n"] -= 1
        return {
            "status": "success",
            "summary": "ok",
            "data": {},
            "artifacts": [],
            "warnings": [],
        }

    monkeypatch.setattr(server.SCRIPT_RUNNER, "run", fake_run)

    async def two_at_once():
        inputs = {"source_path": "inbox/sample-note.md"}
        return await asyncio.gather(
            server._execute("md-stats", dict(inputs), True, "t1"),
            server._execute("md-stats", dict(inputs), True, "t2"),
        )

    results = asyncio.run(two_at_once())
    assert all(r["status"] == "success" for r in results)
    assert max_active["n"] == 1, "two executions overlapped despite limit=1"
