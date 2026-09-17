/** config.yaml loading with env overrides (deviation #3 in docs/NODE-PLAN.md:
 * HUB_REGISTRY_PATH / HUB_WORKSPACE_ROOT simplify testing and smoke runs;
 * defaults still come from config.yaml shared with the Python implementation). */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { load as loadYaml } from "js-yaml";

export interface JobStoreConfig {
  type: "memory" | "sqlite";
  path: string;
}

export interface HubConfig {
  server: { host: string; port: number };
  registry: string;
  workspaceRoot: string;
  globalConcurrency: number;
  jobStore: JobStoreConfig;
  /** undefined = authorization off (everything allowed, legacy behavior). */
  authorization?: Record<string, any>;
}

export function loadConfig(configPath: string): HubConfig {
  const raw = loadYaml(readFileSync(configPath, "utf8")) as Record<string, any>;
  const config = raw ?? {};
  // relative paths in config.yaml resolve against the config file's directory,
  // matching the Python implementation (PROJECT_ROOT-relative)
  const base = path.dirname(path.resolve(configPath));
  const env = (v: string | undefined): string | undefined =>
    v && v.trim() ? v.trim() : undefined;
  const jobStoreType = String(config.job_store?.type ?? "sqlite");
  return {
    server: {
      host: String(config.server?.host ?? "0.0.0.0"),
      port: Number(config.server?.port ?? 8800),
    },
    registry: path.resolve(
      base,
      env(process.env.HUB_REGISTRY_PATH) ??
        String(config.registry ?? "./registry.yaml"),
    ),
    workspaceRoot: path.resolve(
      base,
      env(process.env.HUB_WORKSPACE_ROOT) ??
        String(config.workspace_root ?? "./workspace"),
    ),
    globalConcurrency: Number(config.limits?.global_concurrency ?? 1),
    jobStore: {
      type: jobStoreType === "memory" ? "memory" : "sqlite",
      path: path.resolve(
        base,
        env(process.env.HUB_JOB_STORE_PATH) ??
          String(config.job_store?.path ?? "./logs/jobs.db"),
      ),
    },
    authorization: config.authorization,
  };
}
