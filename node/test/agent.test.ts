import { readdirSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "./expect.js";

import { AgentRunner } from "../src/agent_runner.js";
import { SkillExecutionError, SkillInputError } from "../src/errors.js";
import { ScriptRunner } from "../src/runner.js";
import { buildFixture, type Fixture } from "./helpers.js";

let fixture: Fixture;
let runner: AgentRunner;

beforeEach(() => {
  fixture = buildFixture();
  runner = new AgentRunner(
    fixture.registry,
    new ScriptRunner(fixture.registry, fixture.workspaceRoot),
  );
});

describe("AgentRunner (real fake-claude processes)", () => {
  it("runs the success path via the result file", async () => {
    const envelope = await runner.run(
      "agent-ok",
      { note_path: "inbox/a.md" },
      { client: "test" },
    );
    expect(envelope.status).toBe("success");
    expect(envelope.data.verdict).toBe("strong");
    expect(typeof envelope.duration_ms).toBe("number");
    // the CLI flags are built from the registry runtime block
    expect(envelope.data.argv).toContain("--model");
    expect(envelope.data.argv).toContain("haiku");
    expect(envelope.data.argv).toContain("--max-turns");
    expect(envelope.data.argv).toContain("15");
    // the temp dir is cleaned up afterwards
    const tempDir = path.join(runner.guard.root, "temp");
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("falls back to the CLI result text when no result file was written", async () => {
    const envelope = await runner.run("agent-fallback", { note_path: "inbox/a.md" });
    expect(envelope.status).toBe("success");
    expect(envelope.data.verdict).toBe("strong");
  });

  it("parses fenced envelopes out of agent chatter", async () => {
    const envelope = await runner.run("agent-fenced", { note_path: "inbox/a.md" });
    expect(envelope.status).toBe("success");
    expect(envelope.summary).toBe("值得写");
  });

  it("surfaces nonzero exits with scrubbed stderr", async () => {
    const err = await runner.run("agent-fail", { note_path: "inbox/a.md" }).then(
      () => {
        throw new Error("agent-fail should have failed");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SkillExecutionError);
    expect((err as Error).message).toMatch(/exited with code 3/);
    expect((err as Error).message).toContain("[REDACTED]");
    expect((err as Error).message).not.toContain("sk-abc");
  });

  it("times out and kills the inner agent tree", { timeout: 15_000 }, async () => {
    await expect(runner.run("agent-slow", { note_path: "inbox/a.md" })).rejects.toThrow(
      /timed out after 2s \(inner agent killed\)/,
    );
  });

  it("reports a missing CLI clearly", async () => {
    fixture.registry.skills.get("agent-ok")!.runtime.executable =
      "definitely-not-a-real-cmd-xyz";
    await expect(runner.run("agent-ok", { note_path: "inbox/a.md" })).rejects.toThrow(
      /Agent CLI not found/,
    );
  });

  it("rejects unsupported providers before spawning", async () => {
    fixture.registry.skills.get("agent-ok")!.runtime.provider = "codex";
    await expect(runner.run("agent-ok", { note_path: "inbox/a.md" })).rejects.toThrow(
      /Unsupported agent provider "codex"/,
    );
  });

  it("rejects a missing SKILL.md before spawning", async () => {
    await expect(
      runner.run("agent-badskill", { note_path: "inbox/a.md" }),
    ).rejects.toThrow(/SKILL.md not found/);
  });

  it("confines agent input paths before any process starts", async () => {
    await expect(
      runner.run("agent-ok", { note_path: "../.." }),
    ).rejects.toThrow(/outside the allowed workspace/);
    await expect(
      runner.run("agent-ok", { note_path: "inbox/nope.md" }),
    ).rejects.toBeInstanceOf(SkillInputError);
  });
});
