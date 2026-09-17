/** Server assembly: /health + bearer middleware + stateless MCP at /mcp +
 * REST API at /api. Both API surfaces share one execution core (Hub). */

import { timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";

import { registerFirstClassTools, registerMcpTools } from "../api/mcp.js";
import { restRouter } from "../api/rest.js";
import type { Hub } from "../core/hub.js";
import type { SkillRegistry } from "../core/registry.js";

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

  app.use("/api", restRouter(ctx));

  return app;
}

function createMcpServer(ctx: HubContext): McpServer {
  const server = new McpServer({ name: "skill-hub", version: "0.2.0" });
  registerMcpTools(server, ctx);
  registerFirstClassTools(server, ctx.hub, ctx.registry);
  return server;
}
