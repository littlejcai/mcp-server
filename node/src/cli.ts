#!/usr/bin/env node
/** skillhub CLI — local entry point over the same execution core as the HTTP
 * server (no network, no auth needed: it talks to the Hub directly).
 *
 *   skillhub list
 *   skillhub describe <skill_id>
 *   skillhub run <skill_id> [--input key=value ...] [--no-dry-run] [--client name]
 *   skillhub jobs [--limit N]
 *   skillhub job <job_id>
 *
 * Jobs use the same configured job store as the server (sqlite by default), so
 * `skillhub jobs` sees what the server submitted and vice versa. */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite is experimental (N2 chose it for zero-dependency persistence);
// opting in deliberately, so silence the per-run stderr banner.
process.removeAllListeners("warning");

import { AuditLog } from "./core/audit.js";
import { Hub } from "./core/hub.js";
import { MemoryJobStore } from "./core/jobs.js";
import { SkillRegistry } from "./core/registry.js";
import { ScriptRunner } from "./core/runner.js";
import { Semaphore } from "./core/semaphore.js";
import { SqliteJobStore } from "./core/sqlite_jobs.js";
import { loadConfig } from "./server/config.js";
import { findRepoRoot } from "./server/paths.js";

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

function buildHub(): Hub {
  const config = loadConfig(path.join(REPO_ROOT, "config.yaml"));
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

function fail(message: string): never {
  console.error(`skillhub: ${message}`);
  process.exit(1);
}

function parseInputs(pairs: string[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      fail(`--input expects key=value, got ${JSON.stringify(pair)}`);
    }
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return inputs;
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const hub = buildHub();

  switch (cmd) {
    case "list": {
      printJson({ skills: hub.registry.list() });
      break;
    }
    case "describe": {
      const skillId = rest[0];
      if (!skillId) fail("describe requires <skill_id>");
      printJson(hub.registry.describe(skillId));
      break;
    }
    case "run": {
      const skillId = rest[0];
      if (!skillId) fail("run requires <skill_id>");
      let dryRun = true;
      let client = "cli";
      const inputPairs: string[] = [];
      for (let i = 1; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--dry-run") dryRun = true;
        else if (arg === "--no-dry-run") dryRun = false;
        else if (arg === "--client") {
          const value = rest[i + 1];
          if (!value || value.startsWith("-")) fail("--client requires a name");
          client = value;
          i++;
        } else if (arg.startsWith("--input=")) {
          inputPairs.push(arg.slice("--input=".length));
        } else if (arg === "--input") {
          const value = rest[i + 1];
          if (!value || value.startsWith("-")) fail("--input requires key=value");
          inputPairs.push(value);
          i++;
        } else {
          fail(`unknown argument ${JSON.stringify(arg)}`);
        }
      }
      const envelope = await hub.execute(
        skillId,
        parseInputs(inputPairs),
        dryRun,
        client,
      );
      printJson(envelope);
      break;
    }
    case "jobs": {
      const limitArg = rest.find((a) => a.startsWith("--limit="));
      const limit =
        limitArg !== undefined
          ? Number(limitArg.slice("--limit=".length))
          : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        fail("--limit must be an integer in 1..100");
      }
      printJson({ jobs: hub.jobs(limit) });
      break;
    }
    case "job": {
      const jobId = rest[0];
      if (!jobId) fail("job requires <job_id>");
      printJson(hub.job(jobId));
      break;
    }
    case undefined:
    case "--help":
    case "-h":
    case "help": {
      printJson({
        usage: [
          "skillhub list",
          "skillhub describe <skill_id>",
          "skillhub run <skill_id> [--input key=value ...] [--no-dry-run] [--client name]",
          "skillhub jobs [--limit N]",
          "skillhub job <job_id>",
        ],
      });
      break;
    }
    default:
      fail(`unknown command ${JSON.stringify(cmd)} (see skillhub help)`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
