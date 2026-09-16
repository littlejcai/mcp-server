/** HTTP layer: /health + bearer middleware + stateless MCP at /mcp
 * (port of server.py's Starlette app, Express edition). */

import { timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import type { Hub } from "./hub.js";
import type { SkillRegistry } from "./registry.js";

export interface HubContext {
  registry: SkillRegistry;
  hub: Hub;
  token: string;
}

export function buildApp(ctx: HubContext): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // registered before the middleware: /health is the only unauthenticated route
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, skills: ctx.registry.skills.size });
  });

  // Pure bearer check for every route below (mirror of BearerTokenMiddleware).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const provided = req.headers.authorization ?? "";
    const expected = `Bearer ${ctx.token}`;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "2mb" }));

  app.post("/mcp", async (req: Request, res: Response) => {
    // Stateless mode: fresh server+transport per request, nothing session-shaped
    // to leak between callers. GET SSE streams are a planned N2 addition.
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ error: "Method not allowed (stateless MCP: POST only)" });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

function createMcpServer(ctx: HubContext): McpServer {
  const server = new McpServer({ name: "skill-hub", version: "0.1.0" });

  server.registerTool(
    "list_skills",
    {
      description: "List the skills registered on this hub (id, name, description, risk).",
    },
    async () => jsonResult(ctx.registry.list()),
  );

  server.registerTool(
    "describe_skill",
    {
      description: "Get one skill's description, parameter JSON schema, and timeout.",
      inputSchema: { skill_id: z.string() },
    },
    async ({ skill_id }) => {
      try {
        return jsonResult(ctx.registry.describe(skill_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "run_skill",
    {
      description:
        "Execute a registered skill. `inputs` must match its input schema. " +
        "`dry_run` defaults to true: write-capable skills only preview changes. " +
        "Pass false to let the skill actually write. `run_mode` defaults to " +
        '"sync"; use "async" to submit a job and poll get_job instead of blocking.',
      inputSchema: {
        skill_id: z.string(),
        inputs: z.record(z.string(), z.unknown()).optional(),
        dry_run: z.boolean().default(true),
        run_mode: z.enum(["sync", "async"]).default("sync"),
      },
    },
    async ({ skill_id, inputs, dry_run, run_mode }) => {
      try {
        if (run_mode === "async") {
          const job = ctx.hub.submit(skill_id, inputs ?? {}, dry_run, "");
          return jsonResult({
            job_id: job.job_id,
            status: job.status,
            skill_id: job.skill_id,
            dry_run: job.dry_run,
            submitted_at: job.submitted_at,
          });
        }
        return jsonResult(
          await ctx.hub.execute(skill_id, inputs ?? {}, dry_run, ""),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      description:
        "Fetch one submitted job by id: status (queued/running/succeeded/failed), " +
        "the response envelope once finished, and failure reason if any.",
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      try {
        return jsonResult(ctx.hub.job(job_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_jobs",
    {
      description:
        "List recently submitted jobs, newest first (default 20, max 100).",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    },
    async ({ limit }) => {
      try {
        return jsonResult(ctx.hub.jobs(limit));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}
