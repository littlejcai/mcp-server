import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "./expect.js";

import { SkillRegistry } from "../src/core/registry.js";
import { REPO_ROOT } from "./helpers.js";

const realRegistry = () =>
  new SkillRegistry(path.join(REPO_ROOT, "registry.yaml"), REPO_ROOT);

describe("SkillRegistry (real registry.yaml)", () => {
  it("loads the repo registry with both demo skills", () => {
    expect([...realRegistry().skills.keys()].sort()).toEqual([
      "md-stats",
      "note-worthiness",
    ]);
  });

  it("list() leaks no permission details", () => {
    const entry = realRegistry()
      .list()
      .find((s) => s.id === "md-stats")!;
    expect(entry).toEqual({
      id: "md-stats",
      name: "Markdown 统计",
      description: expect.any(String),
      type: "script",
      risk_level: "workspace_write",
    });
  });

  it("describe() exposes schema and timeout", () => {
    const d = realRegistry().describe("md-stats");
    expect(d.input_schema).toBeTruthy();
    expect(d.timeout_seconds).toBe(60);
  });

  it("pathScopes picks up x-path-scope annotations", () => {
    expect(realRegistry().pathScopes("md-stats")).toEqual({
      source_path: "read",
      output_path: "write",
    });
  });

  it("firstClassIds() marks both demo skills", () => {
    expect(realRegistry().firstClassIds().sort()).toEqual([
      "md-stats",
      "note-worthiness",
    ]);
  });

  it("unknown skills raise UnknownSkillError", () => {
    expect(() => realRegistry().get("nope")).toThrow(/Unknown skill/);
  });

  it("validateInputs enforces the skill schema", () => {
    const reg = realRegistry();
    expect(() => reg.validateInputs("md-stats", {})).toThrow(
      /Input validation failed/,
    );
    expect(() =>
      reg.validateInputs("md-stats", {
        source_path: "inbox/x.md",
        top_headings: "many",
      }),
    ).toThrow(/Input validation failed/);
    expect(() =>
      reg.validateInputs("md-stats", { source_path: "inbox/x.md" }),
    ).not.toThrow();
  });
});

describe("SkillRegistry (meta-schema validation)", () => {
  function writeRegistry(yaml: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "reg-"));
    mkdirSync(dir, { recursive: true });
    const registryPath = path.join(dir, "registry.yaml");
    writeFileSync(registryPath, yaml, "utf8");
    return registryPath;
  }

  it("rejects unknown runtime keys so typos fail loudly", () => {
    const registryPath = writeRegistry(`version: 1
skills:
  broken:
    name: Broken
    description: has a typo in a runtime key
    type: script
    runtime:
      executable: node
      timeout_second: 5
    input_schema:
      type: object
`);
    expect(() => new SkillRegistry(registryPath, path.dirname(registryPath))).toThrow(
      /registry.yaml is invalid/,
    );
  });

  it("filters disabled skills", () => {
    const registryPath = writeRegistry(`version: 1
skills:
  off:
    name: Off
    description: disabled skill
    type: script
    enabled: false
    runtime:
      executable: node
    input_schema:
      type: object
  on:
    name: On
    description: enabled skill
    type: script
    runtime:
      executable: node
    input_schema:
      type: object
`);
    const reg = new SkillRegistry(registryPath, path.dirname(registryPath));
    expect([...reg.skills.keys()]).toEqual(["on"]);
  });
});
