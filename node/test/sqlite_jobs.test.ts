/** SQLite job store: same contract as MemoryJobStore, plus persistence across
 * reopens (the N2 "JobStore 内存→SQLite" acceptance). */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "./expect.js";

import { errorEnvelope } from "../src/core/envelope.js";
import { MemoryJobStore } from "../src/core/jobs.js";
import { SqliteJobStore } from "../src/core/sqlite_jobs.js";

function withDb<T>(fn: (dbPath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hub-sqlite-"));
  try {
    return fn(path.join(dir, "jobs.db"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function successEnvelope(): Parameters<SqliteJobStore["complete"]>[1] {
  return {
    v: 1,
    status: "success",
    summary: "done",
    data: { words: 12 },
    artifacts: [],
    warnings: [],
    duration_ms: 5,
  };
}

describe("SqliteJobStore", () => {
  it("mirrors MemoryJobStore record shape and lifecycle", () => {
    withDb((dbPath) => {
      const sqlite = new SqliteJobStore(dbPath);
      const memory = new MemoryJobStore(10);
      const job = sqlite.create("md-stats-js", true, "test");
      expect(job).toMatchObject({
        skill_id: "md-stats-js",
        status: "queued",
        dry_run: true,
        client: "test",
      });
      expect(job.envelope).toEqual(null);
      expect(job.error).toEqual(null);

      sqlite.markRunning(job.job_id);
      expect(sqlite.get(job.job_id)?.status).toBe("running");
      expect(sqlite.get(job.job_id)?.started_at).toBeTruthy();

      sqlite.complete(job.job_id, successEnvelope());
      const done = sqlite.get(job.job_id)!;
      expect(done.status).toBe("succeeded");
      expect(done.envelope?.status).toBe("success");
      expect(done.envelope?.data.words).toBe(12);
      expect(done.duration_ms).toBe(5);
      expect(done.finished_at).toBeTruthy();

      sqlite.fail(job.job_id, "boom");
      const failed = sqlite.get(job.job_id)!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("boom");
      expect(failed.envelope).toEqual(errorEnvelope("boom"));

      // list newest first
      const other = sqlite.create("failer", false, "test");
      const listed = sqlite.list(10);
      expect(listed.map((j) => j.job_id)).toEqual([other.job_id, job.job_id]);

      sqlite.close();
    });
  });

  it("persists jobs across store reopens (survives a restart)", () => {
    withDb((dbPath) => {
      const first = new SqliteJobStore(dbPath);
      const job = first.create("md-stats-js", true, "persist");
      first.markRunning(job.job_id);
      first.complete(job.job_id, successEnvelope());
      first.close();

      // fresh handle on the same file — as after a server restart
      const second = new SqliteJobStore(dbPath);
      const restored = second.get(job.job_id)!;
      expect(restored.status).toBe("succeeded");
      expect(restored.skill_id).toBe("md-stats-js");
      expect(restored.dry_run).toBe(true);
      expect(restored.client).toBe("persist");
      expect(restored.envelope?.data.words).toBe(12);
      expect(second.list(10).map((j) => j.job_id)).toEqual([job.job_id]);
      second.close();
    });
  });

  it("evicts oldest terminal jobs first under capacity", () => {
    withDb((dbPath) => {
      const store = new SqliteJobStore(dbPath, 2);
      const j1 = store.create("a", true, "t");
      const j2 = store.create("b", true, "t");
      store.complete(j1.job_id, successEnvelope());
      store.complete(j2.job_id, successEnvelope());
      const j3 = store.create("c", true, "t");
      const j4 = store.create("d", true, "t");
      // capacity 2: each over-capacity create evicts the oldest terminal job,
      // so j1 (then j2) go before any queued job
      expect(store.get(j1.job_id)).toBeUndefined();
      expect(store.get(j2.job_id)).toBeUndefined();
      expect(store.get(j3.job_id)).toBeTruthy();
      expect(store.get(j4.job_id)).toBeTruthy();
      expect(store.list(10).length).toBe(2);
      store.close();
    });
  });

  it("round-trips a failed job envelope", () => {
    withDb((dbPath) => {
      const store = new SqliteJobStore(dbPath);
      const job = store.create("failer", false, "t");
      store.fail(job.job_id, "skill-hub internal error: nope");
      const restored = store.get(job.job_id)!;
      expect(restored.status).toBe("failed");
      expect(restored.error).toBe("skill-hub internal error: nope");
      expect(restored.envelope).toEqual(errorEnvelope("skill-hub internal error: nope"));
      store.close();
    });
  });
});
