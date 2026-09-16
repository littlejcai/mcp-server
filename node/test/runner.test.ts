import { existsSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "./expect.js";

import { SkillExecutionError, SkillInputError } from "../src/errors.js";
import { ScriptRunner } from "../src/runner.js";
import { buildFixture, type Fixture } from "./helpers.js";

let fixture: Fixture;
let runner: ScriptRunner;

beforeEach(() => {
  fixture = buildFixture();
  runner = new ScriptRunner(fixture.registry, fixture.workspaceRoot);
});

describe("ScriptRunner (real subprocess)", () => {
  it("runs the fixture skill end to end", async () => {
    const envelope = await runner.run(
      "md-stats-js",
      { source_path: "inbox/a.md" },
      { client: "test" },
    );
    expect(envelope.status).toBe("success");
    expect(envelope.data.words).toBe(12);
    expect(typeof envelope.duration_ms).toBe("number");
  });

  it("rejects path escapes before starting any process", async () => {
    await expect(
      runner.run("md-stats-js", { source_path: "inbox/../.." }),
    ).rejects.toThrow(/outside the allowed workspace/);
  });

  it("rejects missing read-scope sources", async () => {
    await expect(
      runner.run("md-stats-js", { source_path: "inbox/nope.md" }),
    ).rejects.toThrow(/does not exist/);
  });

  it("dry_run writes nothing but reports the artifact", async () => {
    const envelope = await runner.run(
      "md-stats-js",
      { source_path: "inbox/a.md", output_path: "output/report.md" },
      { dryRun: true },
    );
    expect(
      existsSync(path.join(fixture.workspaceRoot, "output", "report.md")),
    ).toBe(false);
    expect(envelope.artifacts.length).toBeGreaterThan(0);
  });

  it("writes the report when dry_run is false", async () => {
    const envelope = await runner.run(
      "md-stats-js",
      { source_path: "inbox/a.md", output_path: "output/report.md" },
      { dryRun: false },
    );
    expect(
      existsSync(path.join(fixture.workspaceRoot, "output", "report.md")),
    ).toBe(true);
    expect(envelope.artifacts[0]).toMatchObject({ written: true });
  });

  it("times out and reports the kill", { timeout: 15_000 }, async () => {
    await expect(runner.run("slowpoke", {})).rejects.toThrow(
      /timed out after 2s and was killed/,
    );
  });

  it("surfaces nonzero exits with scrubbed stderr", async () => {
    const err = await runner.run("failer", {}).then(
      () => {
        throw new Error("failer should have failed");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SkillExecutionError);
    expect((err as Error).message).toMatch(/exited with code 2/);
    expect((err as Error).message).toContain("[REDACTED]");
    expect((err as Error).message).not.toContain("supersecret123");
  });

  it("raises UnknownSkillError for unregistered ids", async () => {
    await expect(runner.run("nope", {})).rejects.toThrow(/Unknown skill/);
  });

  it("raises SkillInputError for unsafe inputs", async () => {
    await expect(
      runner.run("md-stats-js", { source_path: "../.." }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });

  it("rejects a write-scope input with no matching declared roots", async () => {
    // strip the filesystem permissions so the x-path-scope has no roots
    fixture.registry.skills.get("md-stats-js")!.permissions = {};
    await expect(
      runner.run("md-stats-js", { source_path: "inbox/a.md", output_path: "output/r.md" }),
    ).rejects.toThrow(/declares x-path-scope/);
  });
});
