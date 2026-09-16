/** Append-only JSONL audit log — one line per skill invocation
 * (port of hub/audit.py). Writes are serialized through a promise chain;
 * the file format is shared with the Python implementation. */

import { appendFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

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
}
