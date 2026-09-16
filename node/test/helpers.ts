/** Shared test fixtures: a throwaway workspace + a registry that runs the
 * Node-implemented fixture skills (no Python needed). */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { findRepoRoot } from "../src/paths.js";
import { SkillRegistry } from "../src/registry.js";

export const REPO_ROOT = findRepoRoot(
  path.dirname(fileURLToPath(import.meta.url)),
);
export const FIXTURE_DIR = path.join(REPO_ROOT, "node", "test", "fixtures");

export const FIXTURE_CONTENT = "# T\n\nhello world 内容\n".repeat(3);

export interface Fixture {
  workspaceRoot: string;
  registryPath: string;
  registry: SkillRegistry;
}

export function buildFixture(): Fixture {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "skill-hub-node-"));
  mkdirSync(path.join(workspaceRoot, "inbox"), { recursive: true });
  mkdirSync(path.join(workspaceRoot, "output"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, "inbox", "a.md"), FIXTURE_CONTENT, "utf8");

  const fixture = (name: string) => path.join(FIXTURE_DIR, name);
  const registryYaml = `version: 1
skills:
  md-stats-js:
    name: Markdown stats (JS fixture)
    description: JS port of md-stats used by the Node-side test suite.
    type: script
    risk_level: workspace_write
    runtime:
      executable: node
      args:
        - ${fixture("md-stats-js.mjs")}
      working_directory: .
      timeout_seconds: 60
      max_stdout_bytes: 100000
    input_schema:
      type: object
      properties:
        source_path:
          type: string
          x-path-scope: read
        output_path:
          type: string
          x-path-scope: write
        top_headings:
          type: integer
          default: 10
      required:
        - source_path
    permissions:
      filesystem:
        read: [inbox, output]
        write: [output]
      network: false
      environment:
        allow: []
  failer:
    name: Failer
    description: Always exits nonzero with a secret-looking stderr line.
    type: script
    risk_level: read_only
    runtime:
      executable: node
      args:
        - ${fixture("failer.mjs")}
    input_schema:
      type: object
      properties: {}
  slowpoke:
    name: Slowpoke
    description: Sleeps far beyond its timeout; used for the kill test.
    type: script
    risk_level: read_only
    runtime:
      executable: node
      args:
        - ${fixture("slow.mjs")}
      timeout_seconds: 2
    input_schema:
      type: object
      properties: {}
  agent-demo:
    name: Agent demo
    description: Agent-type entry; the Node MVP rejects it until N1 lands.
    type: agent
    risk_level: read_only
    runtime:
      provider: claude-code
      executable: claude
    input_schema:
      type: object
      properties: {}
`;
  const registryPath = path.join(workspaceRoot, "registry.yaml");
  writeFileSync(registryPath, registryYaml, "utf8");
  return {
    workspaceRoot,
    registryPath,
    registry: new SkillRegistry(registryPath, REPO_ROOT),
  };
}
