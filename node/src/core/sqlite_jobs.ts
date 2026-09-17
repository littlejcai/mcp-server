/** SQLite-backed job store (N2: JobStore 内存→SQLite 持久化). Implements the
 * same JobStore interface and record shape as MemoryJobStore, so Hub and its
 * callers are storage-agnostic. Jobs survive restarts; capacity eviction
 * mirrors the in-memory policy (oldest terminal job first, else oldest). */

import { DatabaseSync } from "node:sqlite";

import { errorEnvelope, type Envelope } from "./envelope.js";
import {
  type JobRecord,
  type JobStore,
  TERMINAL,
  makeJob,
  newJobId,
  nowIso,
} from "./jobs.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id        TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  dry_run       INTEGER NOT NULL,
  client        TEXT NOT NULL,
  submitted_at  TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  envelope      TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_submitted ON jobs (submitted_at DESC);
`;

export class SqliteJobStore implements JobStore {
  private db: DatabaseSync;

  constructor(
    dbPath: string,
    readonly capacity = 200,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  create(skillId: string, dryRun: boolean, client: string): JobRecord {
    this.evictIfFull();
    const job = makeJob(newJobId(), skillId, dryRun, client);
    this.db
      .prepare(
        `INSERT INTO jobs
           (job_id, skill_id, status, dry_run, client, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(job.job_id, job.skill_id, job.status, dryRun ? 1 : 0, job.client, job.submitted_at);
    return job;
  }

  get(jobId: string): JobRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE job_id = ?`)
      .get(jobId) as SqliteRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  list(limit: number): JobRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs ORDER BY submitted_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as unknown as SqliteRow[];
    return rows.map(rowToJob);
  }

  markRunning(jobId: string): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE job_id = ?`)
      .run(nowIso(), jobId);
  }

  complete(jobId: string, envelope: Envelope): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'succeeded', finished_at = ?,
           duration_ms = ?, envelope = ? WHERE job_id = ?`,
      )
      .run(nowIso(), envelope.duration_ms ?? null, JSON.stringify(envelope), jobId);
  }

  fail(jobId: string, message: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', finished_at = ?, error = ?,
           envelope = ? WHERE job_id = ?`,
      )
      .run(nowIso(), message, JSON.stringify(errorEnvelope(message)), jobId);
  }

  close(): void {
    this.db.close();
  }

  /** Mirror MemoryJobStore eviction: drop the oldest terminal job first,
   * falling back to the oldest overall, while over capacity. */
  private evictIfFull(): void {
    const { count } = this.db
      .prepare(`SELECT COUNT(*) AS count FROM jobs`)
      .get() as { count: number };
    if (count < this.capacity) return;
    const placeholders = TERMINAL.map(() => "?").join(", ");
    const terminal = this.db
      .prepare(
        `SELECT job_id FROM jobs WHERE status IN (${placeholders})
           ORDER BY submitted_at ASC, rowid ASC LIMIT 1`,
      )
      .get(...TERMINAL) as { job_id: string } | undefined;
    const target = terminal?.job_id
      ?? (
        this.db
          .prepare(`SELECT job_id FROM jobs ORDER BY submitted_at ASC, rowid ASC LIMIT 1`)
          .get() as { job_id: string } | undefined
      )?.job_id;
    if (target) {
      this.db.prepare(`DELETE FROM jobs WHERE job_id = ?`).run(target);
    }
  }
}

interface SqliteRow {
  job_id: string;
  skill_id: string;
  status: JobRecord["status"];
  dry_run: number;
  client: string;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  envelope: string | null;
  error: string | null;
}

function rowToJob(row: SqliteRow): JobRecord {
  let envelope: Envelope | null = null;
  if (row.envelope !== null) {
    try {
      envelope = JSON.parse(row.envelope) as Envelope;
    } catch {
      envelope = null;
    }
  }
  return {
    job_id: row.job_id,
    skill_id: row.skill_id,
    status: row.status,
    dry_run: row.dry_run === 1,
    client: row.client,
    submitted_at: row.submitted_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    envelope,
    error: row.error,
  };
}
