/** Script-type runner: fixed executable + argv array + stdin envelope
 * (port of hub/runner.py).
 *
 * Platform specifics handled here:
 *   - timeout kills the whole tree: POSIX via detached process group +
 *     kill(-pid, SIGKILL) (deliberate improvement #2 in docs/NODE-PLAN.md —
 *     the Python version only kills the direct child on POSIX), Windows via
 *     ``taskkill /T /F``
 *   - stdout/stderr are capped while streaming so a runaway process cannot
 *     exhaust memory
 *   - child gets a minimal environment, not process.env
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { buildRequest, parseEnvelope, type Envelope } from "./envelope.js";
import { SkillExecutionError, SkillInputError } from "./errors.js";
import {
  DEFAULT_MAX_STDOUT,
  DEFAULT_TIMEOUT,
  type SkillConfig,
  type SkillRegistry,
} from "./registry.js";
import { PathGuard, buildEnv, scrub } from "./security.js";

/** Turn a registry executable name into an argv prefix the OS accepts.
 *
 * npm-style shims (``claude.CMD`` etc.) are not directly launchable on
 * Windows and go through ``cmd /c`` with their resolved path. Extension-less
 * POSIX-style shims fall back to the bare name and the OS PATH search.
 */
export function resolveExecutable(name: string): string[] {
  if (name.includes("/") || name.includes("\\")) return [name];
  const found = whichSync(name);
  if (!found) return [name];
  const lowered = found.toLowerCase();
  if (lowered.endsWith(".cmd") || lowered.endsWith(".bat")) {
    const comspec = process.env.COMSPEC ?? "cmd.exe";
    return [comspec, "/d", "/c", found];
  }
  if (lowered.endsWith(".exe") || lowered.endsWith(".com")) return [found];
  return [name];
}

function whichSync(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function killTree(child: ChildProcess): void {
  /** Terminate the whole child tree; plain kill() leaks grandchildren. */
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        timeout: 10_000,
      });
    } catch {
      // best effort
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** Streaming collector that stores at most cap+1 bytes and keeps draining. */
function cappedCollector(cap: number) {
  let stored = 0;
  let total = 0;
  const chunks: Buffer[] = [];
  return {
    push(chunk: Buffer): void {
      total += chunk.length;
      if (stored <= cap) {
        const take = chunk.subarray(0, cap + 1 - stored);
        chunks.push(take);
        stored += take.length;
      }
    },
    text(): { text: string; truncated: boolean } {
      return {
        text: Buffer.concat(chunks).toString("utf8"),
        truncated: total > cap,
      };
    },
  };
}

export interface RunOptions {
  dryRun?: boolean;
  client?: string;
}

export class ScriptRunner {
  readonly guard: PathGuard;

  constructor(
    readonly registry: SkillRegistry,
    workspaceRoot: string,
  ) {
    this.guard = new PathGuard(workspaceRoot);
  }

  async run(
    skillId: string,
    inputs: Record<string, unknown>,
    { dryRun = true, client = "" }: RunOptions = {},
  ): Promise<Envelope> {
    const runtime = this.registry.runtime(skillId);
    const permissions = this.registry.permissions(skillId);
    const timeoutSeconds = Number(runtime.timeout_seconds ?? DEFAULT_TIMEOUT);
    const maxStdout = Number(runtime.max_stdout_bytes ?? DEFAULT_MAX_STDOUT);

    const confined = this.confinePaths(skillId, inputs);
    const argv = [
      ...resolveExecutable(String(runtime.executable)),
      ...((runtime.args as string[]) ?? []),
    ];
    const requestBody = buildRequest(skillId, confined, { dryRun, client });

    const workdir = this.workingDirectory(runtime);
    const env = buildEnv(
      (permissions.environment?.allow as string[] | undefined) ?? [],
    );

    const started = performance.now();
    const stdoutCap = cappedCollector(maxStdout);
    const stderrCap = cappedCollector(20_000);
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: workdir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // new process group on POSIX so the timeout can kill the whole tree
      detached: process.platform !== "win32",
    });

    // the skill may exit before consuming stdin; EPIPE then is not an error
    child.stdin?.on("error", () => {});
    child.stdin?.end(requestBody, "utf8");
    child.stdout?.on("data", (chunk: Buffer) => stdoutCap.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrCap.push(chunk));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutSeconds * 1000);
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          finish(
            new SkillExecutionError(
              `Executable for skill ${JSON.stringify(skillId)} not found: ${argv[0]} (${err.message})`,
            ),
          );
        } else {
          finish(
            new SkillExecutionError(
              `Skill ${JSON.stringify(skillId)} failed to start: ${err.message}`,
            ),
          );
        }
      });
      child.on("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        finish();
      });
    });

    if (timedOut) {
      throw new SkillExecutionError(
        `Skill ${JSON.stringify(skillId)} timed out after ${timeoutSeconds}s and was killed`,
      );
    }

    if (exitCode !== 0) {
      const stderrText = stderrCap.text().text;
      const codeLabel = exitCode ?? `signal ${exitSignal}`;
      throw new SkillExecutionError(
        `Skill ${JSON.stringify(skillId)} exited with code ${codeLabel}: ${scrub(stderrText)}`,
      );
    }

    const { text: stdoutText, truncated } = stdoutCap.text();
    const envelope = parseEnvelope(stdoutText);
    if (truncated) {
      envelope.warnings.push("stdout exceeded cap and was truncated");
    }
    envelope.duration_ms = Math.round(performance.now() - started);
    return envelope;
  }

  /** Resolve x-path-scope inputs and replace them with confined absolute paths.
   *
   * The skill never sees the caller's raw path string, only a path the hub
   * has already proven to be inside the declared permission roots.
   */
  confinePaths(
    skillId: string,
    inputs: Record<string, unknown>,
  ): Record<string, unknown> {
    const scopes = this.registry.pathScopes(skillId);
    const fs = this.registry.permissions(skillId).filesystem ?? {};
    const confined = { ...inputs };
    for (const [key, scope] of Object.entries(scopes)) {
      if (!(key in confined)) continue;
      const roots = (fs[scope] as string[] | undefined) ?? [];
      if (!roots.length) {
        throw new SkillExecutionError(
          `Input ${JSON.stringify(key)} declares x-path-scope=${JSON.stringify(scope)} but the ` +
            "registry lists no matching filesystem roots",
        );
      }
      confined[key] = this.guard.resolve(confined[key], {
        allowed: roots,
        mustExist: scope === "read",
      });
    }
    return confined;
  }

  private workingDirectory(runtime: SkillConfig): string {
    const configured = runtime.working_directory as string | undefined;
    if (!configured) return this.registry.projectRoot;
    const resolved = this.registry.resolveProject(configured);
    const projectRoot = this.registry.projectRoot;
    if (
      resolved !== projectRoot &&
      !resolved.startsWith(projectRoot + path.sep)
    ) {
      throw new SkillExecutionError(
        `working_directory ${JSON.stringify(configured)} is outside the project root`,
      );
    }
    return resolved;
  }
}

// re-export for callers that only care about input errors
export { SkillInputError };
