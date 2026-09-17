/** Script-type runner: fixed executable + argv array + stdin envelope
 * (port of hub/runner.py). Process lifecycle and confinement now go through
 * the ExecutionDriver (N3): the default ProcessDriver spawns a child directly;
 * a container/sandbox driver can replace it without touching this module. */

import { accessSync, constants } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { type ExecutionDriver, ProcessDriver } from "./driver.js";
import { buildRequest, parseEnvelope, type Envelope } from "./envelope.js";
import { SkillExecutionError, SkillInputError } from "./errors.js";
import {
  DEFAULT_MAX_STDOUT,
  DEFAULT_TIMEOUT,
  type SkillConfig,
  type SkillRegistry,
} from "./registry.js";
import { PathGuard, buildEnv, scrub } from "./security.js";

export { killTree } from "./driver.js";

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

export interface RunOptions {
  dryRun?: boolean;
  client?: string;
}

export class ScriptRunner {
  readonly guard: PathGuard;
  private readonly driver: ExecutionDriver;

  constructor(
    readonly registry: SkillRegistry,
    workspaceRoot: string,
    driver: ExecutionDriver = new ProcessDriver(),
  ) {
    this.guard = new PathGuard(workspaceRoot);
    this.driver = driver;
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
    const out = await this.driver.run({
      argv,
      cwd: workdir,
      env,
      stdin: requestBody,
      timeoutMs: timeoutSeconds * 1000,
      maxStdoutBytes: maxStdout,
      maxStderrBytes: 20_000,
    });

    if (out.timedOut) {
      throw new SkillExecutionError(
        `Skill ${JSON.stringify(skillId)} timed out after ${timeoutSeconds}s and was killed`,
      );
    }

    if (out.spawnError) {
      if (out.spawnError.code === "ENOENT") {
        throw new SkillExecutionError(
          `Executable for skill ${JSON.stringify(skillId)} not found: ${argv[0]} (${out.spawnError.message})`,
        );
      }
      throw new SkillExecutionError(
        `Skill ${JSON.stringify(skillId)} failed to start: ${out.spawnError.message}`,
      );
    }

    if (out.exitCode !== 0) {
      const codeLabel = out.exitCode ?? `signal ${out.exitSignal}`;
      throw new SkillExecutionError(
        `Skill ${JSON.stringify(skillId)} exited with code ${codeLabel}: ${scrub(out.stderr)}`,
      );
    }

    const envelope = parseEnvelope(out.stdout);
    if (out.stdoutTruncated) {
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
