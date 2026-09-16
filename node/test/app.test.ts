import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "./expect.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { AuditLog } from "../src/audit.js";
import { buildApp } from "../src/app.js";
import { Hub } from "../src/hub.js";
import { JobStore } from "../src/jobs.js";
import { ScriptRunner } from "../src/runner.js";
import { Semaphore } from "../src/semaphore.js";
import { buildFixture, type Fixture } from "./helpers.js";

const TOKEN = "test-token-123";

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
    new JobStore(),
  );
  const app = buildApp({ registry: fixture.registry, hub, token: TOKEN });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function makeClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "vitest", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  return content?.[0]?.text ?? "";
}

describe("HTTP layer", () => {
  it("serves /health without a token", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  it("rejects /mcp without or with a wrong token", async () => {
    const noToken = await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  it("answers 405 for GET /mcp in stateless mode", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });
});

describe("MCP tool surface over streamable HTTP", () => {
  it("lists exactly the dispatcher and job tools", async () => {
    const client = await makeClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "describe_skill",
        "get_job",
        "list_jobs",
        "list_skills",
        "run_skill",
      ]);
    } finally {
      await client.close();
    }
  });

  it("describes a skill with its schema and timeout", async () => {
    const client = await makeClient();
    try {
      const result = await client.callTool({
        name: "describe_skill",
        arguments: { skill_id: "md-stats-js" },
      });
      expect(result.isError).toBeFalsy();
      const described = JSON.parse(textOf(result));
      expect(described.id).toBe("md-stats-js");
      expect(described.input_schema).toBeTruthy();
      expect(described.timeout_seconds).toBe(60);
    } finally {
      await client.close();
    }
  });

  it("runs the fixture skill end to end over HTTP", async () => {
    const client = await makeClient();
    try {
      const result = await client.callTool({
        name: "run_skill",
        arguments: {
          skill_id: "md-stats-js",
          inputs: { source_path: "inbox/a.md" },
        },
      });
      expect(result.isError).toBeFalsy();
      const envelope = JSON.parse(textOf(result));
      expect(envelope.status).toBe("success");
      expect(envelope.v).toBe(1);
      expect(envelope.data.words).toBe(12);
    } finally {
      await client.close();
    }
  });

  it("submits an async job and resolves it via get_job", async () => {
    const client = await makeClient();
    try {
      const submit = await client.callTool({
        name: "run_skill",
        arguments: {
          skill_id: "md-stats-js",
          inputs: { source_path: "inbox/a.md" },
          run_mode: "async",
        },
      });
      expect(submit.isError).toBeFalsy();
      const handle = JSON.parse(textOf(submit));
      expect(handle.job_id).toMatch(/^job_[0-9a-f]{12}$/);
      // status is a snapshot; a free semaphore starts the job right away
      expect(handle.status === "queued" || handle.status === "running").toBe(true);

      const deadline = Date.now() + 10_000;
      for (;;) {
        const poll = JSON.parse(
          textOf(
            await client.callTool({
              name: "get_job",
              arguments: { job_id: handle.job_id },
            }),
          ),
        );
        if (poll.status === "succeeded") {
          expect(poll.envelope.status).toBe("success");
          expect(poll.envelope.data.words).toBe(12);
          break;
        }
        if (poll.status === "failed") {
          throw new Error(`job failed: ${poll.error}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`job still ${poll.status} after 10s`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const listed = JSON.parse(
        textOf(
          await client.callTool({ name: "list_jobs", arguments: { limit: 10 } }),
        ),
      );
      expect(Array.isArray(listed)).toBe(true);
      expect(listed.some((j: { job_id: string }) => j.job_id === handle.job_id)).toBe(
        true,
      );
    } finally {
      await client.close();
    }
  });

  it("maps hub errors to tool errors with the same keywords as Python", async () => {
    const client = await makeClient();
    try {
      const unknown = await client.callTool({
        name: "describe_skill",
        arguments: { skill_id: "nope" },
      });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toMatch(/Unknown skill/);

      const violation = await client.callTool({
        name: "run_skill",
        arguments: { skill_id: "md-stats-js", inputs: {} },
      });
      expect(violation.isError).toBe(true);
      expect(textOf(violation)).toMatch(/Input validation failed/);

      const escape = await client.callTool({
        name: "run_skill",
        arguments: {
          skill_id: "md-stats-js",
          inputs: { source_path: "../../etc" },
        },
      });
      expect(escape.isError).toBe(true);
      expect(textOf(escape)).toMatch(/outside the allowed workspace/);

      const agent = await client.callTool({
        name: "run_skill",
        arguments: { skill_id: "agent-demo", inputs: {} },
      });
      expect(agent.isError).toBe(true);
      expect(textOf(agent)).toMatch(/Agent-type skill/);
    } finally {
      await client.close();
    }
  });
});
