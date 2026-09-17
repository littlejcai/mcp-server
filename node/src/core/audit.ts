/** Append-only JSONL audit log — one line per skill invocation
 * (port of hub/audit.py). Writes are serialized through a promise chain;
 * the file format is shared with the Python implementation. N3 adds the
 * read side (AuditLog.query) for the audit API. */

import { appendFile, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

export interface AuditEntry {
  ts: string;
  skill_id?: string;
  status?: string;
  duration_ms?: number | null;
  inputs_summary?: Record<string, string>;
  client?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface AuditQuery {
  limit?: number;
  skill_id?: string;
  status?: string;
  client?: string;
}

export const AUDIT_MAX_LIMIT = 200;

export class AuditLog {
  readonly path: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(logDir: string) {
    mkdirSync(logDir, { recursive: true });
    this.path = path.join(logDir, "audit.jsonl");
  }

  record(fields: Record<string, unknown>): void {
    const entry = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      ...fields,
    };
    const line = JSON.stringify(entry) + "\n";
    this.chain = this.chain
      .then(() => appendFile(this.path, line, "utf8"))
      .catch((err) => {
        console.error(`[skill-hub] audit write failed: ${err}`);
      });
  }

  /** Read back audit entries, newest first, with optional filters.
   * The file is append-only, so newest entries live at the tail; this reads
   * the whole file and keeps the last `limit` matches (fine for N3; swap for
   * an index/tail reader when the log grows large). */
  async query(q: AuditQuery = {}): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 50)), AUDIT_MAX_LIMIT);
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return []; // no log yet
    }
    const entries: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (q.skill_id !== undefined && entry.skill_id !== q.skill_id) continue;
        if (q.status !== undefined && entry.status !== q.status) continue;
        if (q.client !== undefined && entry.client !== q.client) continue;
        entries.push(entry);
      } catch {
        // skip malformed line rather than fail the whole query
      }
    }
    return entries.slice(-limit).reverse();
  }
}
