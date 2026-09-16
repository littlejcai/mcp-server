"""skill-hub server: registry-driven MCP tools over Streamable HTTP + Bearer auth.

Layout of the public tool surface (hybrid mode):
  - always: list_skills / describe_skill / run_skill (dispatcher)
  - plus one first-class tool per skill marked ``first_class: true``

Config lives in config.yaml; the auth token comes from the ``HUB_TOKEN``
environment variable or ``secrets.token`` (auto-created on first start).
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import os
import secrets
import sys
from pathlib import Path
from typing import Any

import yaml
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

from hub.agent_runner import AgentRunner
from hub.audit import AuditLog
from hub.envelope import error_envelope
from hub.errors import SkillHubError
from hub.registry import SkillRegistry
from hub.runner import ScriptRunner

PROJECT_ROOT = Path(__file__).resolve().parent

mcp = FastMCP("skill-hub")


# --------------------------------------------------------------------------
# config / singletons
# --------------------------------------------------------------------------

def _load_config() -> dict[str, Any]:
    config_path = PROJECT_ROOT / "config.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    config.setdefault("workspace_root", "./workspace")
    config.setdefault("registry", "./registry.yaml")
    config.setdefault("limits", {})
    return config


CONFIG = _load_config()
REGISTRY = SkillRegistry(
    PROJECT_ROOT / CONFIG["registry"], project_root=PROJECT_ROOT
)
WORKSPACE_ROOT = (PROJECT_ROOT / CONFIG["workspace_root"]).resolve()
SCRIPT_RUNNER = ScriptRunner(REGISTRY, WORKSPACE_ROOT)
AGENT_RUNNER = AgentRunner(REGISTRY, WORKSPACE_ROOT)
AUDIT = AuditLog(PROJECT_ROOT / "logs")
CONCURRENCY_LIMIT = int(CONFIG["limits"].get("global_concurrency", 1))
# One semaphore per event loop: asyncio primitives bind to the loop that
# first awaits them, and tests may run several loops in one process.
_SEMAPHORES: dict[int, asyncio.Semaphore] = {}


def _semaphore() -> asyncio.Semaphore:
    loop_id = id(asyncio.get_running_loop())
    sem = _SEMAPHORES.get(loop_id)
    if sem is None:
        sem = asyncio.Semaphore(CONCURRENCY_LIMIT)
        _SEMAPHORES[loop_id] = sem
    return sem


def _load_token() -> str:
    token = os.environ.get("HUB_TOKEN", "").strip()
    if token:
        return token
    token_file = PROJECT_ROOT / "secrets.token"
    if not token_file.exists():
        token_file.write_text(secrets.token_urlsafe(24), encoding="utf-8")
    return token_file.read_text(encoding="utf-8").strip()


AUTH_TOKEN = _load_token()


# --------------------------------------------------------------------------
# execution core shared by dispatcher and first-class tools
# --------------------------------------------------------------------------

async def _execute(
    skill_id: str, inputs: dict[str, Any], dry_run: bool, client: str
) -> dict[str, Any]:
    try:
        REGISTRY.validate_inputs(skill_id, inputs)
        runner = (
            AGENT_RUNNER if REGISTRY.get(skill_id)["type"] == "agent" else SCRIPT_RUNNER
        )
        async with _semaphore():
            envelope = await runner.run(
                skill_id, inputs, dry_run=dry_run, client=client
            )
    except SkillHubError as exc:
        AUDIT.record(skill_id=skill_id, status="rejected", reason=str(exc), client=client)
        raise ToolError(str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — surface as tool error, keep serving
        AUDIT.record(skill_id=skill_id, status="failed", reason=str(exc), client=client)
        raise ToolError(f"skill-hub internal error: {exc}") from exc
    AUDIT.record(
        skill_id=skill_id,
        status=envelope["status"],
        duration_ms=envelope.get("duration_ms"),
        inputs_summary=_summarize(inputs),
        client=client,
    )
    return envelope


def _summarize(inputs: dict[str, Any], limit: int = 200) -> dict[str, Any]:
    return {
        key: (value if len(str(value)) <= limit else str(value)[:limit] + "…")
        for key, value in inputs.items()
    }


# --------------------------------------------------------------------------
# MCP tools
# --------------------------------------------------------------------------

@mcp.tool
def list_skills() -> list[dict[str, Any]]:
    """List the skills registered on this hub (id, name, description, risk)."""
    return REGISTRY.list()


@mcp.tool
def describe_skill(skill_id: str) -> dict[str, Any]:
    """Get one skill's description, parameter JSON schema, and timeout."""
    try:
        return REGISTRY.describe(skill_id)
    except SkillHubError as exc:
        raise ToolError(str(exc)) from exc


@mcp.tool
async def run_skill(
    skill_id: str, inputs: dict[str, Any] | None = None, dry_run: bool = True
) -> dict[str, Any]:
    """Execute a registered skill. ``inputs`` must match its input schema.

    ``dry_run`` defaults to true: write-capable skills only preview changes.
    Pass false to let the skill actually write.
    """
    return await _execute(skill_id, inputs or {}, dry_run, client="")


def _register_first_class_tools() -> None:
    """One dedicated tool per registry skill marked first_class: true."""
    try:
        import pydantic

        for skill_id in REGISTRY.first_class_ids():
            config = REGISTRY.get(skill_id)
            schema = config["input_schema"]
            fields = {}
            for prop_name, prop in (schema.get("properties") or {}).items():
                py_type = {
                    "string": str,
                    "integer": int,
                    "number": float,
                    "boolean": bool,
                }.get(prop.get("type"), Any)
                if prop_name in (schema.get("required") or []):
                    fields[prop_name] = (py_type, ...)
                else:
                    fields[prop_name] = (py_type | None, prop.get("default"))
            if schema.get("type") == "object" and not fields:
                fields["inputs"] = (dict[str, Any], {})

            model = pydantic.create_model(
                f"{skill_id.replace('-', '_')}_inputs", **fields
            )

            def _make(skill_id: str, model, config):
                tool_name = skill_id.replace("-", "_")

                async def run(inputs: model, dry_run: bool = True) -> dict[str, Any]:  # noqa: B008
                    """Dedicated tool generated from the registry entry."""
                    return await _execute(
                        skill_id,
                        {k: v for k, v in inputs.model_dump().items() if v is not None},
                        dry_run,
                        client=f"first-class:{tool_name}",
                    )

                run.__annotations__["inputs"] = model
                run.__name__ = tool_name
                run.__doc__ = (
                    f"{config['description']} "
                    f"(risk: {config.get('risk_level', 'unknown')}; "
                    f"dry_run defaults to true)"
                )
                return mcp.tool(run)

            _make(skill_id, model, config)
    except Exception as exc:  # noqa: BLE001 — dispatcher tools still work
        print(f"[skill-hub] first-class tool registration failed: {exc}", file=sys.stderr)


_register_first_class_tools()


# --------------------------------------------------------------------------
# HTTP: /health + bearer middleware + mounted MCP app
# --------------------------------------------------------------------------

async def _health(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "skills": len(REGISTRY.skills)})


class BearerTokenMiddleware:
    """Pure-ASGI bearer check for every route except /health."""

    def __init__(self, app, token: str, exempt: tuple[str, ...] = ("/health",)):
        self.app = app
        self.token = token.encode()
        self.exempt = exempt

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("path") not in self.exempt:
            headers = {k.lower(): v for k, v in scope.get("headers", [])}
            provided = headers.get(b"authorization", b"")
            if not hmac.compare_digest(provided, b"Bearer " + self.token):
                await send(
                    {
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [(b"content-type", b"application/json")],
                    }
                )
                await send(
                    {
                        "type": "http.response.body",
                        "body": b'{"error":"unauthorized"}',
                    }
                )
                return
        await self.app(scope, receive, send)


def build_app() -> Starlette:
    mcp_app = mcp.http_app(path="/mcp")
    app = Starlette(
        routes=[
            Route("/health", _health, methods=["GET"]),
            Mount("/", app=mcp_app),
        ],
        lifespan=mcp_app.router.lifespan_context,
    )
    return BearerTokenMiddleware(app, AUTH_TOKEN)


if __name__ == "__main__":
    import uvicorn

    host = str(CONFIG.get("server", {}).get("host", "0.0.0.0"))
    port = int(CONFIG.get("server", {}).get("port", 8800))
    print(f"[skill-hub] http://{host}:{port}/mcp  (skills: {len(REGISTRY.skills)})")
    if host not in ("127.0.0.1", "localhost"):
        print(f"[skill-hub] LAN exposure ON — clients need: "
              f"Authorization: Bearer <token>  (HUB_TOKEN env or secrets.token)")
    with contextlib.suppress(KeyboardInterrupt):
        uvicorn.run(build_app(), host=host, port=port, log_level="info")
