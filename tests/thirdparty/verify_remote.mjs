// Third-party client verification: connect to skill-hub with the official
// TypeScript MCP SDK (an implementation independent of Python fastmcp),
// then exercise the tool surface over Streamable HTTP + Bearer auth.
//
// Usage: node verify_remote.mjs <base-url>
//   base-url defaults to http://127.0.0.1:8800
// The auth token is read from ../../secrets.token relative to this file.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const baseUrl = process.argv[2] ?? "http://127.0.0.1:8800";
const token = readFileSync(join(here, "../../secrets.token"), "utf8").trim();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures++;
};

const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "verify-node-sdk", version: "1.0.0" });

// 1. wrong token must be rejected before we open the real connection
{
  const badTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer wrong" } },
  });
  const badClient = new Client({ name: "verify-node-bad", version: "1.0.0" });
  let rejected = false;
  try {
    await badClient.connect(badTransport);
    await badClient.listTools(); // force a round trip
  } catch {
    rejected = true;
  }
  check("wrong token rejected", rejected);
}

// 2. authenticated connect + tool discovery
await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
check(
  "listTools returns 5 tools",
  names.length === 5,
  names.join(", ")
);
const mdStats = tools.tools.find((t) => t.name === "md_stats");
check("first-class tool exposes JSON schema", !!mdStats?.inputSchema?.properties?.inputs);

// 3. call a script-type skill via dispatcher
{
  const res = await client.callTool({
    name: "run_skill",
    arguments: {
      skill_id: "md-stats",
      inputs: { source_path: "inbox/sample-note.md" },
      dry_run: true,
    },
  });
  const envelope = JSON.parse(res.content[0].text);
  check("run_skill md-stats", envelope.status === "success", envelope.summary ?? "");
}

// 4. call the generated first-class tool
{
  const res = await client.callTool({
    name: "md_stats",
    arguments: { inputs: { source_path: "inbox/sample-note.md" }, dry_run: true },
  });
  const envelope = JSON.parse(res.content[0].text);
  check("md_stats first-class", envelope.status === "success", `words=${envelope.data?.words}`);
}

// 5. rejection paths surface as error results (isError flag / thrown error
//    depending on SDK client behavior)
{
  let rejected = false;
  try {
    const res = await client.callTool({
      name: "run_skill",
      arguments: { skill_id: "md-stats", inputs: { source_path: "../../.ssh/id_rsa" } },
    });
    if (res.isError) {
      rejected = true;
      console.log(`      reason: ${res.content?.[0]?.text?.slice(0, 80)}`);
    }
  } catch {
    rejected = true;
  }
  check("path escape rejected", rejected);
}

client.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
