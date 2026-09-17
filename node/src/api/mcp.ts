/** MCP API surface: the /mcp tool registration over the shared execution core.
 * Every tool delegates to the same Hub that the REST surface uses — the two
 * entry points are interchangeable clients of one execution kernel. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { buildToolShape, splitToolArgs } from "../core/first_class.js";
import type { Hub } from "../core/hub.js";
import type { SkillRegistry } from "../core/registry.js";

export interface McpContext {
  registry: SkillRegistry;
  hub: Hub;
}

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Register the five dispatcher tools on an MCP server. */
export function registerMcpTools(
  server: McpServer,
  ctx: McpContext,
): void {
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
}

/** One dedicated first-class tool per registry skill marked first_class: true.
 * Tool name = skill_id with "-" replaced by "_"; the handler delegates to the
 * same execution core as run_skill, tagged client "first-class:<name>".
 * Registration is guarded per skill: a malformed entry skips that tool instead
 * of killing the whole surface. */
export function registerFirstClassTools(
  server: McpServer,
  hub: Hub,
  registry: SkillRegistry,
): void {
  for (const skillId of registry.firstClassIds()) {
    try {
      const config = registry.get(skillId);
      const toolName = skillId.replace(/-/g, "_");
      const shape = buildToolShape(config.input_schema);
      server.registerTool(
        toolName,
        {
          description:
            `${String(config.description)} ` +
            `(risk: ${String(config.risk_level ?? "unknown")}; dry_run defaults to true)`,
          inputSchema: { ...shape, dry_run: z.boolean().default(true) },
        },
        async (args: Record<string, unknown>) => {
          try {
            const { inputs, dryRun } = splitToolArgs(args);
            return jsonResult(
              await hub.execute(
                skillId,
                inputs,
                dryRun,
                `first-class:${toolName}`,
              ),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      );
    } catch (err) {
      console.error(
        `[skill-hub] first-class tool registration failed for ${skillId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
