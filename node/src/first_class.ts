/** One dedicated first-class tool per registry skill marked first_class: true
 * (port of server.py _register_first_class_tools, pydantic edition -> zod).
 *
 * Tool name = skill_id with "-" replaced by "_"; the handler delegates to the
 * same execution core as run_skill, tagged client "first-class:<name>".
 * Registration is guarded per skill: a malformed entry skips that tool instead
 * of killing the whole surface (the Python version guarded the entire loop).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Hub } from "./hub.js";
import type { SkillRegistry } from "./registry.js";

function propToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const base =
    prop.type === "string"
      ? z.string()
      : prop.type === "integer"
        ? z.number().int()
        : prop.type === "number"
          ? z.number()
          : prop.type === "boolean"
            ? z.boolean()
            : z.unknown();
  return base;
}

/** Build the zod raw shape for registerTool from a skill's JSON Schema. */
export function buildToolShape(
  schema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const properties =
    (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(properties)) {
    const base = propToZod(prop);
    const fallback = prop.default as unknown;
    shape[name] = required.has(name)
      ? base
      : fallback !== undefined
        ? base.default(fallback)
        : base.optional();
  }
  // mirror the Python builder: an object schema with no properties becomes a
  // single optional "inputs" object so the tool still accepts arbitrary input
  if (schema.type === "object" && Object.keys(shape).length === 0) {
    shape.inputs = z.record(z.string(), z.unknown()).default({});
  }
  return shape;
}

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
            const { dry_run, ...rest } = args;
            // mirror the pydantic handler: drop unset optionals before executing
            const inputs = Object.fromEntries(
              Object.entries(rest).filter(([, v]) => v !== undefined),
            );
            return jsonResult(
              await hub.execute(
                skillId,
                inputs,
                dry_run === true,
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

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}
