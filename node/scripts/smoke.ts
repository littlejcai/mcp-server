/** End-to-end smoke: verify a running skill-hub Node server from a real MCP
 * client, exactly the way external agents would reach it.
 *
 * Usage: npm run smoke -- [baseUrl] [token]
 * Defaults: http://127.0.0.1:8811 and $HUB_TOKEN.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.argv[2] ?? process.env.HUB_URL ?? "http://127.0.0.1:8811";
const token = process.argv[3] ?? process.env.HUB_TOKEN ?? "";

/** The hub is a LAN service; a smoke tool must not double as an arbitrary
 * fetch primitive, so targets default to loopback/private ranges. */
function assertLocalHttpUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported scheme for smoke target: ${url.protocol}`);
  }
  const host = url.hostname;
  const isLocal =
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]";
  if (!isLocal && process.env.HUB_SMOKE_ALLOW_PUBLIC !== "1") {
    throw new Error(
      `refusing non-local smoke target ${host} — the hub is a LAN service; ` +
        "set HUB_SMOKE_ALLOW_PUBLIC=1 to override deliberately",
    );
  }
  return url.origin;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

async function expectStatus(
  name: string,
  url: string,
  init: RequestInit,
  expected: number,
): Promise<void> {
  const res = await fetch(url, init);
  check(name, res.status === expected, `(got ${res.status})`);
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  return content?.[0]?.text ?? "";
}

async function main(): Promise<void> {
  const target = assertLocalHttpUrl(baseUrl);
  console.log(`smoke against ${target}`);

  await expectStatus("GET /health needs no token", `${target}/health`, {}, 200);
  await expectStatus(
    "POST /mcp without token is 401",
    `${target}/mcp`,
    { method: "POST", body: "{}" },
    401,
  );
  await expectStatus(
    "POST /mcp with wrong token is 401",
    `${target}/mcp`,
    { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" },
    401,
  );

  const transport = new StreamableHTTPClientTransport(new URL(`${target}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "skill-hub-smoke", version: "0.0.1" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    check(
      "tools/list has the dispatcher trio",
      ["describe_skill", "list_skills", "run_skill"].every((n) => names.includes(n)),
      `(got ${names.join(", ")})`,
    );

    const listed = await client.callTool({ name: "list_skills", arguments: {} });
    const skills = JSON.parse(textOf(listed));
    check(
      "list_skills returns the registry catalog",
      Array.isArray(skills) &&
        skills.length >= 1 &&
        skills.every((s: Record<string, unknown>) => "id" in s && "risk_level" in s),
    );

    const described = await client.callTool({
      name: "describe_skill",
      arguments: { skill_id: "md-stats" },
    });
    check(
      "describe_skill(md-stats) exposes its schema",
      !described.isError &&
        Boolean(JSON.parse(textOf(described)).input_schema),
    );

    const run = await client.callTool({
      name: "run_skill",
      arguments: {
        skill_id: "md-stats",
        inputs: { source_path: "inbox/sample-note.md" },
      },
    });
    const envelope = run.isError ? null : JSON.parse(textOf(run));
    check(
      "run_skill(md-stats) succeeds on inbox/sample-note.md",
      envelope?.status === "success" && typeof envelope?.data?.words === "number",
      JSON.stringify(envelope ?? textOf(run)),
    );

    const bad = await client.callTool({
      name: "run_skill",
      arguments: { skill_id: "nope", inputs: {} },
    });
    check(
      "unknown skill is a tool error",
      bad.isError === true && /Unknown skill/.test(textOf(bad)),
    );

    const escape = await client.callTool({
      name: "run_skill",
      arguments: { skill_id: "md-stats", inputs: { source_path: "../../etc" } },
    });
    check(
      "path escape is a tool error",
      escape.isError === true && /outside the allowed workspace/.test(textOf(escape)),
    );
  } finally {
    await client.close();
  }

  if (failures) {
    console.error(`\nSMOKE FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nSMOKE PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
