/** Registry loader: registry.yaml -> validated skill definitions
 * (port of hub/registry.py). */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { load as loadYaml } from "js-yaml";

import { SkillInputError, UnknownSkillError } from "./errors.js";

// Meta-schema every registry entry must satisfy. Keep strict: unknown
// runtime keys are rejected so typos fail loudly instead of silently
// disabling a limit.
export const SKILL_META_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["name", "description", "type", "runtime", "input_schema"],
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    type: { enum: ["script", "agent"] },
    risk_level: { enum: ["read_only", "workspace_write", "external_write"] },
    first_class: { type: "boolean" },
    enabled: { type: "boolean" },
    runtime: {
      type: "object",
      required: ["executable"],
      additionalProperties: false,
      properties: {
        executable: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        working_directory: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 1 },
        // script type
        max_stdout_bytes: { type: "integer", minimum: 1 },
        // agent type
        provider: { enum: ["claude-code"] },
        skill_file: { type: "string" },
        model: { type: "string" },
        max_turns: { type: "integer", minimum: 1 },
        allowed_tools: { type: "array", items: { type: "string" } },
      },
    },
    input_schema: { type: "object" },
    permissions: {
      type: "object",
      additionalProperties: false,
      properties: {
        filesystem: {
          type: "object",
          additionalProperties: false,
          properties: {
            read: { type: "array", items: { type: "string" } },
            write: { type: "array", items: { type: "string" } },
          },
        },
        network: { type: "boolean" },
        environment: {
          type: "object",
          additionalProperties: false,
          properties: {
            allow: { type: "array", items: { type: "string" } },
            extra: { type: "object", additionalProperties: { type: "string" } },
          },
        },
      },
    },
  },
};

export const DEFAULT_TIMEOUT = 180;
export const DEFAULT_MAX_STDOUT = 100_000;

export type SkillConfig = Record<string, any>;

export class SkillRegistry {
  readonly registryPath: string;
  readonly projectRoot: string;
  skills: Map<string, SkillConfig> = new Map();

  constructor(registryPath: string, projectRoot: string) {
    this.registryPath = path.resolve(registryPath);
    this.projectRoot = path.resolve(projectRoot);
    this.reload();
  }

  reload(): void {
    const data =
      (loadYaml(readFileSync(this.registryPath, "utf8")) as {
        skills?: Record<string, SkillConfig>;
      }) ?? {};
    const skills = data.skills ?? {};
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const errors: string[] = [];
    for (const [skillId, config] of Object.entries(skills)) {
      const valid = ajv.validate(SKILL_META_SCHEMA, config ?? {});
      if (!valid) {
        for (const err of ajv.errors ?? []) {
          errors.push(`${skillId}: ${err.message} (path: ${err.instancePath})`);
        }
      }
    }
    if (errors.length) {
      throw new Error("registry.yaml is invalid:\n  - " + errors.join("\n  - "));
    }
    this.skills = new Map(
      Object.entries(skills).filter(([, c]) => (c as SkillConfig).enabled !== false),
    );
  }

  /** Public summary — no permission details leak here. */
  list(): Record<string, unknown>[] {
    return [...this.skills.entries()].map(([skillId, config]) => ({
      id: skillId,
      name: config.name,
      description: config.description,
      type: config.type,
      risk_level: config.risk_level ?? "unknown",
    }));
  }

  get(skillId: string): SkillConfig {
    const config = this.skills.get(skillId);
    if (!config) {
      throw new UnknownSkillError(
        `Unknown skill ${JSON.stringify(skillId)}; call list_skills for the catalog`,
      );
    }
    return config;
  }

  /** Whitelisted view for describe_skill — config internals stay internal. */
  describe(skillId: string): Record<string, unknown> {
    const config = this.get(skillId);
    return {
      id: skillId,
      name: config.name,
      description: config.description,
      type: config.type,
      risk_level: config.risk_level ?? "unknown",
      input_schema: config.input_schema,
      timeout_seconds: config.runtime.timeout_seconds ?? DEFAULT_TIMEOUT,
    };
  }

  runtime(skillId: string): SkillConfig {
    return this.get(skillId).runtime;
  }

  permissions(skillId: string): SkillConfig {
    return this.get(skillId).permissions ?? {};
  }

  /** Input properties annotated with x-path-scope: {prop: "read"|"write"}.
   *
   * `x-` keywords are invisible to JSON Schema validators; they are the
   * contract that tells the hub which inputs are filesystem paths and
   * which declared roots confine them.
   */
  pathScopes(skillId: string): Record<string, string> {
    const properties =
      (this.get(skillId).input_schema.properties as Record<string, SkillConfig>) ?? {};
    const scopes: Record<string, string> = {};
    for (const [name, prop] of Object.entries(properties)) {
      const scope = prop?.["x-path-scope"];
      if (scope === "read" || scope === "write") scopes[name] = scope;
    }
    return scopes;
  }

  validateInputs(skillId: string, inputs: Record<string, unknown>): void {
    const schema = this.get(skillId).input_schema;
    // strict:false restores the JSON Schema rule that unknown keywords are
    // annotations to be ignored — the Python jsonschema behavior. ajv's
    // strict mode would reject x-path-scope, which the hub relies on.
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const valid = ajv.validate(schema, inputs);
    if (!valid) {
      const errors = [...(ajv.errors ?? [])].sort((a, b) =>
        a.instancePath.localeCompare(b.instancePath),
      );
      const details = errors
        .map((e) => {
          const where = e.instancePath
            ? e.instancePath.replace(/^\//, "").replace(/\//g, ".")
            : "inputs";
          return `${where}: ${e.message}`;
        })
        .join("; ");
      // Deliberate deviation from the Python port: raised as SkillInputError
      // (audited as "rejected") instead of a bare ValueError; message identical.
      throw new SkillInputError(
        `Input validation failed for ${JSON.stringify(skillId)}: ${details}`,
      );
    }
  }

  /** Resolve a registry-relative path (executable args, skill files). */
  resolveProject(relative: string): string {
    return path.isAbsolute(relative)
      ? path.resolve(relative)
      : path.resolve(this.projectRoot, relative);
  }

  firstClassIds(): string[] {
    return [...this.skills.entries()]
      .filter(([, config]) => config.first_class === true)
      .map(([skillId]) => skillId);
  }
}
