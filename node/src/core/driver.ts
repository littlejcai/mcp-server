/** Execution driver contract (N3): how a skill process is actually run and
 * confined. The default ProcessDriver spawns a child with a minimal
 * environment; future drivers (container/sandbox) implement the same
 * interface to trade isolation for runtime — Hub and ScriptRunner do not
 * change. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";

/** Everything needed to execute one skill invocation. */
export interface DriverCommand {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** stdin payload (the request envelope JSON). */
  stdin: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes?: number;
}

export interface DriverOutput {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  timedOut: boolean;
  /** set when spawn itself failed (e.g. ENOENT) before any output */
  spawnError?: NodeJS.ErrnoException | null;
}

export interface ExecutionDriver {
  run(cmd: DriverCommand): Promise<DriverOutput>;
}

/** Terminate the whole child tree; plain kill() leaks grandchildren.
 * Shared with AgentRunner (same timeout semantics). */
export function killTree(child: ChildProcess): void {
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

/** Default driver: a direct child process with a minimal environment, new
 * process group on POSIX (so timeouts kill the whole tree), capped streams. */
export class ProcessDriver implements ExecutionDriver {
  async run(cmd: DriverCommand): Promise<DriverOutput> {
    const stdoutCap = cappedCollector(cmd.maxStdoutBytes);
    const stderrCap = cappedCollector(cmd.maxStderrBytes ?? 20_000);
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let spawnError: NodeJS.ErrnoException | null = null;

    const child = spawn(cmd.argv[0]!, cmd.argv.slice(1), {
      cwd: cmd.cwd,
      env: cmd.env,
      stdio: ["pipe", "pipe", "pipe"],
      // new process group on POSIX so the timeout can kill the whole tree
      detached: process.platform !== "win32",
    });

    // the skill may exit before consuming stdin; EPIPE then is not an error
    child.stdin?.on("error", () => {});
    child.stdin?.end(cmd.stdin, "utf8");
    child.stdout?.on("data", (chunk: Buffer) => stdoutCap.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrCap.push(chunk));

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, cmd.timeoutMs);
      child.on("error", (err: NodeJS.ErrnoException) => {
        spawnError = err;
        finish();
      });
      child.on("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        finish();
      });
    });

    const { text: stdoutText, truncated: stdoutTruncated } = stdoutCap.text();
    return {
      stdout: stdoutText,
      stderr: stderrCap.text().text,
      stdoutTruncated,
      exitCode,
      exitSignal,
      timedOut,
      spawnError: spawnError ?? undefined,
    };
  }
}
