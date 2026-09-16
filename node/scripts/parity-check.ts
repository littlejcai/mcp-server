/** Parity check: compare two running hubs (e.g. Python :8800 and Node :8811)
 * tool by tool — the N1 acceptance gate in docs/NODE-PLAN.md.
 *
 * Usage: npm run parity -- <urlA> <tokenA> <urlB> <tokenB>
 * Volatile fields (duration_ms) are stripped before diffing.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function connect(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "parity-check", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  return content?.[0]?.text ?? "";
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== "duration_ms")
        .map(([k, v]) => [k, stripVolatile(v)]),
    );
  }
  return value;
}

async function main(): Promise<void> {
  const [urlA, tokenA, urlB, tokenB] = process.argv.slice(2);
  if (!urlA || !urlB) {
    console.error(
      "usage: tsx scripts/parity-check.ts <urlA> <tokenA> <urlB> <tokenB>",
    );
    process.exit(2);
  }
  const a = await connect(urlA, tokenA ?? "");
  const b = await connect(urlB, tokenB ?? "");
  let failures = 0;
  const compare = (name: string, x: unknown, y: unknown) => {
    const same = JSON.stringify(x) === JSON.stringify(y);
    if (same) {
      console.log(`  ok  ${name}`);
    } else {
      failures++;
      console.error(`  FAIL ${name}\n    A: ${JSON.stringify(x)}\n    B: ${JSON.stringify(y)}`);
    }
  };
  try {
    compare(
      "list_skills",
      JSON.parse(textOf(await a.callTool({ name: "list_skills", arguments: {} }))),
      JSON.parse(textOf(await b.callTool({ name: "list_skills", arguments: {} }))),
    );
    compare(
      "describe_skill(md-stats)",
      JSON.parse(
        textOf(
          await a.callTool({
            name: "describe_skill",
            arguments: { skill_id: "md-stats" },
          }),
        ),
      ),
      JSON.parse(
        textOf(
          await b.callTool({
            name: "describe_skill",
            arguments: { skill_id: "md-stats" },
          }),
        ),
      ),
    );
    const runArgs = {
      name: "run_skill",
      arguments: {
        skill_id: "md-stats",
        inputs: { source_path: "inbox/sample-note.md" },
      },
    } as const;
    compare(
      "run_skill(md-stats) envelope",
      stripVolatile(JSON.parse(textOf(await a.callTool(runArgs)))),
      stripVolatile(JSON.parse(textOf(await b.callTool(runArgs)))),
    );
  } finally {
    await a.close();
    await b.close();
  }
  if (failures) {
    console.error(`\nPARITY FAILED: ${failures} diff(s)`);
    process.exit(1);
  }
  console.log("\nPARITY OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
