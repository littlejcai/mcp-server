/** AuditLog read side (N3): query with filters, newest first. */

import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { describe, expect, it } from "./expect.js";

import { AuditLog } from "../src/core/audit.js";

function freshLog(): { dir: string; log: AuditLog } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "skill-hub-audit-"));
  return { dir, log: new AuditLog(dir) };
}

/** record() writes are queued on an internal promise chain, so tests poll
 * until the expected number of entries is observable instead of sleeping. */
async function eventually(
  fn: () => Promise<number>,
  expected: number,
  timeoutMs = 3000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await fn();
    if (n >= expected) return n;
    if (Date.now() > deadline) throw new Error(`still ${n}, wanted ${expected}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("AuditLog.query", () => {
  it("returns nothing when the log does not exist yet", async () => {
    const { log } = freshLog();
    expect(await log.query()).toEqual([]);
  });

  it("returns recorded entries newest first", async () => {
    const { log } = freshLog();
    log.record({ skill_id: "a", status: "success", client: "rest" });
    log.record({ skill_id: "b", status: "success", client: "cli" });
    await eventually(() => log.query().then((e) => e.length), 2);
    const entries = await log.query();
    expect(entries.length).toBe(2);
    expect(entries[0]!.skill_id).toBe("b");
    expect(entries[1]!.skill_id).toBe("a");
  });

  it("filters by skill_id / status / client", async () => {
    const { log } = freshLog();
    log.record({ skill_id: "a", status: "success", client: "rest" });
    log.record({ skill_id: "a", status: "error", client: "rest" });
    log.record({ skill_id: "b", status: "success", client: "cli" });
    await eventually(() => log.query({ skill_id: "a" }).then((e) => e.length), 2);
    expect((await log.query({ skill_id: "a", status: "error" })).length).toBe(1);
    expect((await log.query({ client: "cli" })).length).toBe(1);
    expect((await log.query({ skill_id: "nope" })).length).toBe(0);
  });

  it("clamps the limit", async () => {
    const { log } = freshLog();
    for (let i = 0; i < 5; i++) log.record({ skill_id: `s${i}`, status: "success" });
    await eventually(() => log.query().then((e) => e.length), 5);
    expect((await log.query({ limit: 2 })).length).toBe(2);
    // limit 0 and negative fall back to 1; huge values clamp to the max
    expect((await log.query({ limit: 0 })).length).toBe(1);
    expect((await log.query({ limit: 1e9 })).length).toBe(5);
  });

  it("skips malformed lines without failing", async () => {
    const { dir, log } = freshLog();
    log.record({ skill_id: "good", status: "success" });
    await eventually(() => log.query().then((e) => e.length), 1);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(path.join(dir, "audit.jsonl"), "not-json\n");
    log.record({ skill_id: "good2", status: "success" });
    await eventually(() => log.query().then((e) => e.length), 2);
    const entries = await log.query();
    expect(entries.length).toBe(2);
    expect(entries.every((e) => typeof e.skill_id === "string")).toBe(true);
  });
});
