import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "./expect.js";

import { AuditLog } from "../src/audit.js";
import { Hub } from "../src/hub.js";
import { JobStore } from "../src/jobs.js";
import { ScriptRunner } from "../src/runner.js";
import { Semaphore } from "../src/semaphore.js";
import { buildFixture, type Fixture } from "./helpers.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeHub(fixture: Fixture, runner: ScriptRunner, limit = 1): Hub {
  return new Hub(
    fixture.registry,
    runner,
    new AuditLog(tmpDir("hub-audit-")),
    new Semaphore(limit),
    new JobStore(),
  );
}

describe("Hub", () => {
  it("serializes executions under the global concurrency limit", async () => {
    const fixture = buildFixture();
    let active = 0;
    let maxActive = 0;
    const fakeRunner = {
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 100));
        active--;
        return { status: "success", summary: "ok", data: {}, artifacts: [], warnings: [] };
      },
    } as unknown as ScriptRunner;
    const hub = makeHub(fixture, fakeRunner);
    const inputs = { source_path: "inbox/a.md" };
    const [a, b] = await Promise.all([
      hub.execute("md-stats-js", inputs, true, "t1"),
      hub.execute("md-stats-js", inputs, true, "t2"),
    ]);
    expect(a.status).toBe("success");
    expect(b.status).toBe("success");
    expect(maxActive).toBe(1);
  });

  it("audits success and rejection to JSONL", async () => {
    const fixture = buildFixture();
    const auditDir = tmpDir("hub-audit-");
    const hub = new Hub(
      fixture.registry,
      new ScriptRunner(fixture.registry, fixture.workspaceRoot),
      new AuditLog(auditDir),
      new Semaphore(1),
      new JobStore(),
    );
    await hub.execute("md-stats-js", { source_path: "inbox/a.md" }, true, "audit-test");
    await hub.execute("nope", {}).catch(() => {});
    // appends are async fire-and-forget; give them a beat before reading
    await new Promise((r) => setTimeout(r, 100));
    const lines = readFileSync(path.join(auditDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      skill_id: "md-stats-js",
      status: "success",
      client: "audit-test",
    });
    expect(lines[1]).toMatchObject({ skill_id: "nope", status: "rejected" });
  });

  it("audits schema violations as rejected (deliberate deviation #1)", async () => {
    const fixture = buildFixture();
    const auditDir = tmpDir("hub-audit-");
    const hub = new Hub(
      fixture.registry,
      new ScriptRunner(fixture.registry, fixture.workspaceRoot),
      new AuditLog(auditDir),
      new Semaphore(1),
      new JobStore(),
    );
    await hub.execute("md-stats-js", {}).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    const lines = readFileSync(path.join(auditDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ status: "rejected" });
    expect(String(lines[0].reason)).toMatch(/Input validation failed/);
  });
});

