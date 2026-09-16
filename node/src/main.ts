/** skill-hub Node server entry point (mirror of server.py __main__). */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { AuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { JobStore } from "./jobs.js";
import { findRepoRoot } from "./paths.js";
import { SkillRegistry } from "./registry.js";
import { ScriptRunner } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import { buildApp } from "./app.js";

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

function main(): void {
  const config = loadConfig(path.join(REPO_ROOT, "config.yaml"));
  const registry = new SkillRegistry(config.registry, REPO_ROOT);
  const audit = new AuditLog(path.join(REPO_ROOT, "logs"));
  const hub = new Hub(
    registry,
    new ScriptRunner(registry, config.workspaceRoot),
    audit,
    new Semaphore(config.globalConcurrency),
    new JobStore(),
  );
  const app = buildApp({ registry, hub, token: loadToken(REPO_ROOT) });

  app.listen(config.server.port, config.server.host, () => {
    console.log(
      `[skill-hub] http://${config.server.host}:${config.server.port}/mcp  (skills: ${registry.skills.size})`,
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
