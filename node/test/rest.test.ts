/** REST API contract: same execution core as /mcp, JSON error mapping
 * (404 unknown, 400 validation/escape, 401 auth, 500 internal). */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "./expect.js";

import { AuditLog } from "../src/core/audit.js";
import { Hub } from "../src/core/hub.js";
import { MemoryJobStore } from "../src/core/jobs.js";
import { ScriptRunner } from "../src/core/runner.js";
import { Semaphore } from "../src/core/semaphore.js";
import { buildApp } from "../src/server/app.js";
import { buildFixture, type Fixture } from "./helpers.js";

const TOKEN = "rest-test-token";

let fixture: Fixture;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  fixture = buildFixture();
  const hub = new Hub(
    fixture.registry,
    new ScriptRunner(fixture.registry, fixture.workspaceRoot),
    new AuditLog(path.join(fixture.workspaceRoot, "logs")),
    new Semaphore(1),
    new MemoryJobStore(),
  );
  const app = buildApp({ registry: fixture.registry, hub, token: TOKEN });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function authed(pathname: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${TOKEN}`,
    },
  };
}

describe("REST API", () => {
  it("requires a bearer token on /api", async () => {
    const res = await fetch(`${baseUrl}/api/skills`);
    expect(res.status).toBe(401);
  });

  it("lists the skill catalog", async () => {
    const res = await fetch(`${baseUrl}/api/skills`, authed(""));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ id: string }> };
    const ids = body.skills.map((s) => s.id);
    expect(ids).toContain("md-stats-js");
    expect(ids).toContain("failer");
  });

  it("describes one skill with its schema", async () => {
    const res = await fetch(`${baseUrl}/api/skills/md-stats-js`, authed(""));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; input_schema: unknown; timeout_seconds: number };
    expect(body.id).toBe("md-stats-js");
    expect(body.input_schema).toBeTruthy();
    expect(body.timeout_seconds).toBe(60);
  });

  it("returns 404 for an unknown skill", async () => {
    const res = await fetch(`${baseUrl}/api/skills/nope`, authed(""));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown skill/);
  });

  it("runs a skill synchronously and returns the same envelope as MCP", async () => {
    const res = await fetch(
      `${baseUrl}/api/skills/md-stats-js/run`,
      authed("", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs: { source_path: "inbox/a.md" } }),
      }),
    );
    expect(res.status).toBe(200);
    const envelope = (await res.json()) as {
      v: number;
      status: string;
      data: { words: number };
    };
    expect(envelope.v).toBe(1);
    expect(envelope.status).toBe("success");
    expect(envelope.data.words).toBe(12);
  });

  it("submits async jobs with 202 and resolves them via /api/jobs", async () => {
    const submit = await fetch(
      `${baseUrl}/api/skills/md-stats-js/run`,
      authed("", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inputs: { source_path: "inbox/a.md" },
          run_mode: "async",
        }),
      }),
    );
    expect(submit.status).toBe(202);
    const handle = (await submit.json()) as { job_id: string };
    expect(handle.job_id).toMatch(/^job_[0-9a-f]{12}$/);

    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await fetch(`${baseUrl}/api/jobs/${handle.job_id}`, authed(""));
      expect(res.status).toBe(200);
      const job = (await res.json()) as { status: string; envelope?: { data: { words: number } } };
      if (job.status === "succeeded") {
        expect(job.envelope?.data.words).toBe(12);
        break;
      }
      if (job.status === "failed") {
        throw new Error(`job failed`);
      }
      if (Date.now() > deadline) {
        throw new Error(`job still ${job.status} after 10s`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const listed = await fetch(`${baseUrl}/api/jobs?limit=10`, authed(""));
    const { jobs } = (await listed.json()) as { jobs: Array<{ job_id: string }> };
    expect(jobs.some((j) => j.job_id === handle.job_id)).toBe(true);
  });

  it("maps input violations and path escapes to 400", async () => {
    const violation = await fetch(
      `${baseUrl}/api/skills/md-stats-js/run`,
      authed("", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs: {} }),
      }),
    );
    expect(violation.status).toBe(400);
    expect(((await violation.json()) as { error: string }).error).toMatch(/Input validation failed/);

    const escape = await fetch(
      `${baseUrl}/api/skills/md-stats-js/run`,
      authed("", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs: { source_path: "../../etc" } }),
      }),
    );
    expect(escape.status).toBe(400);
    expect(((await escape.json()) as { error: string }).error).toMatch(/outside the allowed workspace/);
  });

  it("returns 404 for an unknown job", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/job_nope`, authed(""));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/Unknown job/);
  });
});
