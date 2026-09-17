/** skill-hub Node server entry point (mirror of server.py __main__). */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite is experimental (N2 chose it for zero-dependency persistence);
// opting in deliberately, so silence the per-run stderr banner.
process.removeAllListeners("warning");

import { AuditLog } from "../core/audit.js";
import { Hub } from "../core/hub.js";
import { MemoryJobStore } from "../core/jobs.js";
import { SkillRegistry } from "../core/registry.js";
import { ScriptRunner } from "../core/runner.js";
import { Semaphore } from "../core/semaphore.js";
import { SqliteJobStore } from "../core/sqlite_jobs.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { findRepoRoot } from "./paths.js";

export const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

function loadToken(repoRoot: string): string {
  const envToken = process.env.HUB_TOKEN?.trim();
  if (envToken) return envToken;
  const tokenFile = path.join(repoRoot, "secrets.token");
  if (!existsSync(tokenFile)) {
    writeFileSync(tokenFile, randomBytes(24).toString("base64url"), "utf8");
  }
  return readFileSync(tokenFile, "utf8").trim();
}

export function buildHub(config: ReturnType<typeof loadConfig>): Hub {
  const registry = new SkillRegistry(config.registry, REPO_ROOT);
  const audit = new AuditLog(path.join(REPO_ROOT, "logs"));
  const jobStore =
    config.jobStore.type === "sqlite"
      ? new SqliteJobStore(config.jobStore.path)
      : new MemoryJobStore();
  return new Hub(
    registry,
    new ScriptRunner(registry, config.workspaceRoot),
    audit,
    new Semaphore(config.globalConcurrency),
    jobStore,
  );
}

function main(): void {
  const config = loadConfig(path.join(REPO_ROOT, "config.yaml"));
  const hub = buildHub(config);
  const app = buildApp({
    registry: hub.registry,
    hub,
    token: loadToken(REPO_ROOT),
  });

  app.listen(config.server.port, config.server.host, () => {
    console.log(
      `[skill-hub] http://${config.server.host}:${config.server.port}/mcp  ` +
        `(skills: ${hub.registry.skills.size}, jobs: ${config.jobStore.type})`,
    );
    if (!["127.0.0.1", "localhost"].includes(config.server.host)) {
      console.log(
        "[skill-hub] LAN exposure ON — clients need: " +
          "Authorization: Bearer <token>  (HUB_TOKEN env or secrets.token)",
      );
    }
  });
}

main();
