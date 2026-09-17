/** Agent-type runner: drive the local Claude Code CLI in headless mode
 * (port of hub/agent_runner.py).
 *
 * Flow: MCP tool -> this runner -> `claude -p` -> the inner agent reads the
 * skill's SKILL.md, does the judgment work, and writes its final envelope to
 * a result file that we read back.
 *
 * Honest limits (no container): the inner agent is constrained by
 * `--allowedTools` (headless mode auto-denies anything not allow-listed), a
 * timeout + tree kill, and a minimal environment. Read-only skills are solid;
 * give write-capable agent skills real isolation before registering them.
 *
 * Deliberate deviation from the Python port (docs/NODE-PLAN.md §6 备注 9):
 * runtime.args are appended before the CLI flags, so tests can drive a fake
 * CLI fixture through the exact same code path without mocks.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { parseEnvelope, type Envelope } from "./envelope.js";
import { SkillExecutionError } from "./errors.js";
import { DEFAULT_TIMEOUT, type SkillConfig, type SkillRegistry } from "./registry.js";
import { type ScriptRunner, killTree, resolveExecutable } from "./runner.js";
import { buildEnv, scrub } from "./security.js";

const DEFAULT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Write"];
const DEFAULT_MAX_TURNS = 20;

export interface RunOptions {
  dryRun?: boolean;
  client?: string;
}

export class AgentRunner {
  constructor(
    readonly registry: SkillRegistry,
    private readonly scriptRunner: ScriptRunner,
  ) {}

  get guard(): ScriptRunner["guard"] {
    return this.scriptRunner.guard;
  }

  async run(
    skillId: string,
    inputs: Record<string, unknown>,
    { dryRun = true, client = "" }: RunOptions = {},
  ): Promise<Envelope> {
    void client;
    const runtime = this.registry.runtime(skillId);
    if ((runtime.provider ?? "claude-code") !== "claude-code") {
      throw new SkillExecutionError(
        `Unsupported agent provider ${JSON.stringify(runtime.provider)}`,
      );
    }

    const skillFile = this.registry.resolveProject(
      String(runtime.skill_file ?? this.defaultSkillFile(skillId)),
    );
    if (!existsSync(skillFile)) {
      throw new SkillExecutionError(`SKILL.md not found: ${skillFile}`);
    }

    const confined = this.scriptRunner.confinePaths(skillId, inputs);

    const maxTurns = Number(runtime.max_turns ?? DEFAULT_MAX_TURNS);
    const timeoutSeconds = Number(runtime.timeout_seconds ?? DEFAULT_TIMEOUT);
    const allowedTools =
      (runtime.allowed_tools as string[] | undefined) ?? DEFAULT_ALLOWED_TOOLS;

    // the temp dir must live inside the workspace: the inner agent is only
    // allowed to touch that root, so the result file has to be in bounds
    const tempRoot = path.join(this.guard.root, "temp");
    mkdirSync(tempRoot, { recursive: true });
    const tempDir = mkdtempSync(path.join(tempRoot, "agent-"));
    const resultPath = path.join(tempDir, "result.json");

    try {
      const prompt = this.buildPrompt(
        skillId,
        skillFile,
        confined,
        dryRun,
        resultPath,
      );

      // prompt travels via stdin: argv stays short and immune to command-line
      // length limits and quoting hazards
      const argv = [
        ...resolveExecutable(String(runtime.executable)),
        ...((runtime.args as string[]) ?? []),
        "-p",
        "--output-format",
        "json",
        "--max-turns",
        String(maxTurns),
        "--allowedTools",
        allowedTools.join(","),
        ...(runtime.model ? ["--model", String(runtime.model)] : []),
      ];
      const env = buildEnv(
        (this.registry.permissions(skillId).environment?.allow as
          | string[]
          | undefined) ?? [],
        { agent: true },
      );

      const started = performance.now();
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: this.guard.root,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      // the CLI may exit before consuming stdin; EPIPE then is not an error
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt, "utf8");

      const stdout = collectStream(child, "stdout");
      const stderr = collectStream(child, "stderr");

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutSeconds * 1000);

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; err?: NodeJS.ErrnoException }>(
        (resolve) => {
          child.on("error", (err: NodeJS.ErrnoException) =>
            resolve({ code: null, signal: null, err }),
          );
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );
      clearTimeout(timer);

      if (exit.err?.code === "ENOENT") {
        throw new SkillExecutionError(
          `Agent CLI not found for skill ${JSON.stringify(skillId)}: ` +
            `${argv[argv.length - 1]} (${exit.err.message})`,
        );
      }
      if (exit.err) {
        throw new SkillExecutionError(
          `Agent CLI for skill ${JSON.stringify(skillId)} failed to start: ${exit.err.message}`,
        );
      }
      if (timedOut) {
        throw new SkillExecutionError(
          `Agent skill ${JSON.stringify(skillId)} timed out after ${timeoutSeconds}s ` +
            "(inner agent killed)",
        );
      }
      if (exit.code !== 0) {
        throw new SkillExecutionError(
          `Agent CLI exited with code ${exit.code}: ${scrub(stderr.text())}`,
        );
      }

      const resultText = extractCliResult(stdout.text());
      const raw = readResultFile(resultPath);

      const envelope = parseEnvelope(raw ?? resultText);
      envelope.duration_ms = Math.round(performance.now() - started);
      return envelope;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private defaultSkillFile(skillId: string): string {
    return `skills/${skillId}/SKILL.md`;
  }

  private buildPrompt(
    skillId: string,
    skillFile: string,
    inputs: Record<string, unknown>,
    dryRun: boolean,
    resultPath: string,
  ): string {
    const request = {
      request_id: `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      action: "run",
      skill_id: skillId,
      inputs,
      dry_run: Boolean(dryRun),
    };
    return (
      `You are executing the registered skill "${skillId}" inside skill-hub.\n` +
      "First read the skill instructions at this exact path and follow them " +
      `precisely: ${skillFile}\n\n` +
      `Workspace root (the only area you may touch): ${this.guard.root}\n` +
      "Request envelope:\n" +
      `${JSON.stringify(request)}\n\n` +
      "Rules:\n" +
      "- Stay inside the workspace root at all times.\n" +
      "- Do not invent tools beyond the ones you have been given.\n" +
      "- As your FINAL action, write the response envelope JSON " +
      "(keys: status, summary, data, artifacts, warnings) to " +
      `${resultPath} using the Write tool. Write nothing else there.`
    );
  }
}

/** ``claude -p --output-format json`` wraps everything in its own JSON. */
export function extractCliResult(cliStdout: string): string {
  try {
    const parsed = JSON.parse(cliStdout) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "result" in (parsed as Record<string, unknown>)
    ) {
      return String((parsed as Record<string, unknown>).result);
    }
  } catch {
    // fall through: treat the whole output as the result text
  }
  return cliStdout;
}

function readResultFile(resultPath: string): string | null {
  if (!existsSync(resultPath)) return null;
  try {
    return readFileSync(resultPath, "utf8");
  } catch {
    return null;
  }
}

/** Drain a child stream into memory (CLI output is small: one JSON object). */
function collectStream(
  child: ChildProcess,
  which: "stdout" | "stderr",
): { text(): string } {
  const chunks: Buffer[] = [];
  child[which]?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return {
    text(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

// keep SkillConfig referenced for symmetric typing with runner.ts
export type { SkillConfig };
