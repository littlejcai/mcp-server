/** First-class tool support: JSON Schema -> zod shape conversion shared by the
 * MCP and REST surfaces (port of server.py's pydantic->FastMCP model builder).
 *
 * Registration itself lives in api/mcp.ts (it depends on the MCP server type);
 * this module stays transport-agnostic so the REST surface can reuse it. */

import { z } from "zod";

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

/** Build the zod raw shape for a tool from a skill's JSON Schema. */
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

/** Split validated tool args into { inputs, dry_run }: drop unset optionals,
 * keep the dry_run flag out of the skill inputs. */
export function splitToolArgs(
  args: Record<string, unknown>,
  reserved: readonly string[] = ["dry_run"],
): { inputs: Record<string, unknown>; dryRun: boolean } {
  const { dry_run, ...rest } = args;
  const inputs = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  );
  return { inputs, dryRun: dry_run === true };
}
