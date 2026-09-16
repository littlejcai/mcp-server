import { describe, expect, it } from "./expect.js";
import * as path from "node:path";

import { UnknownJobError } from "../src/errors.js";
import { JobStore, type JobRecord } from "../src/jobs.js";
import { Hub } from "../src/hub.js";
import { AuditLog } from "../src/audit.js";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { ScriptRunner } from "../src/runner.js";
import { Semaphore } from "../src/semaphore.js";
import { buildFixture, type Fixture } from "./helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the job leaves queued/running, or fail after `timeoutMs`. */
async function awaitTerminal(
  hub: Hub,
  jobId: string,
  timeoutMs = 10_000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = hub.job(jobId);
    if (job.status === "succeeded" || job.status === "failed") return job;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} still ${job.status} after ${timeoutMs}ms`);
    }
    await sleep(50);
  }
}

describe("async jobs (run_mode=async)", () => {
  it("runs to completion in the background and stores the envelope", async () => {
    const fixture = buildFixture();
    const hub = makeHub(fixture);
    const submitted = hub.submit(
      "md-stats-js",
      { source_path: "inbox/a.md" },
      true,
      "async-test",
    );
    // status is a snapshot: with a free semaphore the job starts instantly
    expect(submitted.status === "queued" || submitted.status === "running").toBe(true);
    expect(submitted.job_id).toMatch(/^job_[0-9a-f]{12}$/);

    const job = await awaitTerminal(hub, submitted.job_id);
    expect(job.status).toBe("succeeded");
    expect(job.envelope?.status).toBe("success");
    expect(job.envelope?.data.words).toBe(12);
    expect(job.started_at).toBeTruthy();
    expect(job.finished_at).toBeTruthy();
  });

  it("surfaces subprocess failures on the job record", async () => {
    const fixture = buildFixture();
    const hub = makeHub(fixture);
    const submitted = hub.submit("failer", {}, true, "async-test");
    const job = await awaitTerminal(hub, submitted.job_id);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/exited with code 2/);
    expect(job.envelope?.status).toBe("error");
  });

  it("rejects invalid inputs fail-fast without creating a job", () => {
    const fixture = buildFixture();
    const hub = makeHub(fixture);
    expect(() => hub.submit("md-stats-js", {})).toThrow(/Input validation failed/);
    expect(hub.jobs(100)).toEqual([]);
  });

  it("runs async jobs through the same global semaphore", async () => {
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
    const a = hub.submit("md-stats-js", { source_path: "inbox/a.md" }, true, "t1");
    const b = hub.submit("md-stats-js", { source_path: "inbox/a.md" }, true, "t2");
    await awaitTerminal(hub, a.job_id);
    await awaitTerminal(hub, b.job_id);
    expect(maxActive).toBe(1);
  });

  it("evicts the oldest finished job beyond capacity", () => {
    const store = new JobStore(2);
    const first = store.create("a", true, "");
    store.complete(first.job_id, {
      v: 1,
      status: "success",
      summary: "",
      data: {},
      artifacts: [],
      warnings: [],
    });
    const second = store.create("b", true, "");
    const third = store.create("c", true, "");
    expect(store.get(first.job_id)).toBeUndefined();
    expect(store.get(second.job_id)?.skill_id).toBe("b");
    expect(store.get(third.job_id)?.skill_id).toBe("c");
  });

  it("unknown job ids raise UnknownJobError", () => {
    const fixture = buildFixture();
    const hub = makeHub(fixture);
    expect(() => hub.job("job_nope")).toThrow(/Unknown job/);
    expect(() => hub.job("job_nope")).toThrow(UnknownJobError);
  });
});

function makeHub(fixture: Fixture, runner?: ScriptRunner): Hub {
  return new Hub(
    fixture.registry,
    runner ?? new ScriptRunner(fixture.registry, fixture.workspaceRoot),
    new AuditLog(mkdtempSync(path.join(os.tmpdir(), "job-audit-"))),
    new Semaphore(1),
    new JobStore(),
  );
}
