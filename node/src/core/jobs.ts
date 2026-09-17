/** Job store contract for async skill execution, plus the in-memory
 * implementation (N0.5 era default). The N2 SQLite store
 * (./sqlite_jobs.ts) implements the same interface with a different
 * persistence backend — clients of Hub only ever see JobRecord. */

import { errorEnvelope, type Envelope } from "./envelope.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  job_id: string;
  skill_id: string;
  status: JobStatus;
  dry_run: boolean;
  client: string;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  /** response envelope once the job reached a terminal state */
  envelope: Envelope | null;
  /** failure reason for status "failed" */
  error: string | null;
}

export const TERMINAL: readonly JobStatus[] = ["succeeded", "failed"];

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function newJobId(): string {
  return `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function makeJob(
  jobId: string,
  skillId: string,
  dryRun: boolean,
  client: string,
): JobRecord {
  return {
    job_id: jobId,
    skill_id: skillId,
    status: "queued",
    dry_run: dryRun,
    client,
    submitted_at: nowIso(),
    started_at: null,
    finished_at: null,
    duration_ms: null,
    envelope: null,
    error: null,
  };
}

export interface JobStore {
  create(skillId: string, dryRun: boolean, client: string): JobRecord;
  get(jobId: string): JobRecord | undefined;
  /** Newest first, capped at `limit`. */
  list(limit: number): JobRecord[];
  markRunning(jobId: string): void;
  complete(jobId: string, envelope: Envelope): void;
  fail(jobId: string, message: string): void;
  /** Release backend resources (SQLite handle, …). Optional. */
  close?(): void;
}

/** In-memory implementation: jobs are ephemeral, restarts lose them. */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, JobRecord>();

  constructor(readonly capacity = 200) {}

  create(skillId: string, dryRun: boolean, client: string): JobRecord {
    // eviction prefers the oldest finished job; falls back to the oldest
    // overall so the store can never exceed capacity
    while (this.jobs.size >= this.capacity) {
      let evictKey: string | undefined;
      for (const [key, job] of this.jobs) {
        if (TERMINAL.includes(job.status)) {
          evictKey = key;
          break;
        }
      }
      if (evictKey === undefined) {
        evictKey = this.jobs.keys().next().value;
      }
      if (evictKey === undefined) break;
      this.jobs.delete(evictKey);
    }
    const job = makeJob(newJobId(), skillId, dryRun, client);
    this.jobs.set(job.job_id, job);
    return job;
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  list(limit: number): JobRecord[] {
    return [...this.jobs.values()].slice(-limit).reverse();
  }

  markRunning(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = "running";
      job.started_at = nowIso();
    }
  }

  complete(jobId: string, envelope: Envelope): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = "succeeded";
      job.finished_at = nowIso();
      job.duration_ms = envelope.duration_ms ?? null;
      job.envelope = envelope;
    }
  }

  fail(jobId: string, message: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.finished_at = nowIso();
      job.error = message;
      job.envelope = errorEnvelope(message);
    }
  }
}
