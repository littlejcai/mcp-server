/** CLI contract: `skillhub` subcommands over the same execution core. */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "./expect.js";

import { findRepoRoot } from "../src/server/paths.js";

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(REPO_ROOT, "node", "dist", "src", "cli.js");

function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: REPO_ROOT, timeout: 30_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof (error as { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

describe("skillhub CLI", () => {
  it("lists the registered skills", async () => {
    const { code, stdout, stderr } = await runCli(["list"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as { skills: Array<{ id: string }> };
    const ids = body.skills.map((s) => s.id);
    expect(ids).toContain("md-stats");
    expect(ids).toContain("note-worthiness");
  });

  it("describes one skill", async () => {
    const { code, stdout } = await runCli(["describe", "md-stats"]);
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as { id: string; input_schema: unknown };
    expect(body.id).toBe("md-stats");
    expect(body.input_schema).toBeTruthy();
  });

  it("runs a script skill end to end", async () => {
    const { code, stdout, stderr } = await runCli([
      "run",
      "md-stats",
      "--input",
      "source_path=inbox/sample-note.md",
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const envelope = JSON.parse(stdout) as { status: string; data: Record<string, unknown> };
    expect(envelope.status).toBe("success");
    expect(typeof envelope.data.words).toBe("number");
  });

  it("errors on an unknown command", async () => {
    const { code, stderr } = await runCli(["frobnicate"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown command/);
  });

  it("errors on an unknown job id", async () => {
    const { code, stderr } = await runCli(["job", "job_nope"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Unknown job/);
  });
});
