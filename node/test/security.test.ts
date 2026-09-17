import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "./expect.js";

import { PathGuard, buildEnv, scrub } from "../src/core/security.js";

function tmpWorkspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pathguard-"));
  mkdirSync(path.join(root, "inbox"), { recursive: true });
  writeFileSync(path.join(root, "inbox", "a.md"), "hi", "utf8");
  return root;
}

describe("PathGuard", () => {
  it("resolves relative paths into the workspace", () => {
    const guard = new PathGuard(tmpWorkspace());
    expect(guard.resolve("inbox/a.md")).toBe(
      path.join(guard.root, "inbox", "a.md"),
    );
  });

  it("rejects relative escapes", () => {
    const guard = new PathGuard(tmpWorkspace());
    expect(() => guard.resolve("../..")).toThrow(
      /outside the allowed workspace roots/,
    );
  });

  it("rejects absolute paths outside the workspace", () => {
    const guard = new PathGuard(tmpWorkspace());
    expect(() => guard.resolve("/etc/hosts")).toThrow(
      /outside the allowed workspace roots/,
    );
  });

  it("rejects null bytes, empty strings, and non-strings", () => {
    const guard = new PathGuard(tmpWorkspace());
    expect(() => guard.resolve("a\x00b")).toThrow(/null byte/);
    expect(() => guard.resolve("  ")).toThrow(/non-empty string/);
    expect(() => guard.resolve(42)).toThrow(/non-empty string/);
  });

  it("mustExist requires the path to exist", () => {
    const guard = new PathGuard(tmpWorkspace());
    expect(() => guard.resolve("inbox/nope.md", { mustExist: true })).toThrow(
      /does not exist/,
    );
  });

  it("symlink escape is rejected even when the link sits inside", () => {
    const root = tmpWorkspace();
    const outside = mkdtempSync(path.join(os.tmpdir(), "outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "x", "utf8");
    symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(root, "inbox", "link.txt"),
    );
    const guard = new PathGuard(root);
    expect(() => guard.resolve("inbox/link.txt")).toThrow(
      /outside the allowed workspace roots/,
    );
  });

  it("allowed roots restrict further than the workspace", () => {
    const root = tmpWorkspace();
    const guard = new PathGuard(root);
    expect(guard.resolve("inbox/a.md", { allowed: ["inbox"] })).toContain("inbox");
    expect(() =>
      guard.resolve("inbox/a.md", { allowed: ["output"] }),
    ).toThrow(/outside the allowed workspace roots/);
  });
});

describe("buildEnv", () => {
  it("exposes only base names plus the explicit allowlist", () => {
    process.env.SCRUB_TEST_VAR = "x";
    try {
      const env = buildEnv(["SCRUB_TEST_VAR"]);
      expect(env.PATH).toBeDefined();
      expect(env.SCRUB_TEST_VAR).toBe("x");
      const minimal = buildEnv([]);
      expect(minimal.SCRUB_TEST_VAR).toBeUndefined();
      expect(minimal.PATH).toBeDefined();
    } finally {
      delete process.env.SCRUB_TEST_VAR;
    }
  });

  it("agent mode adds credential lookup paths", () => {
    const env = buildEnv([], { agent: true });
    expect(env.HOME).toBeDefined();
  });
});

describe("scrub", () => {
  it("masks credential-looking strings", () => {
    expect(scrub("key sk-abc12345678 here")).toBe("key [REDACTED] here");
    expect(scrub("password=hunter2")).toBe("[REDACTED]");
    expect(scrub("Bearer abc.def-ghi")).toBe("[REDACTED]");
  });

  it("truncates long output", () => {
    const out = scrub("x".repeat(3000), 100);
    expect(out.startsWith("x".repeat(100))).toBe(true);
    expect(out).toContain("[truncated 2900 chars]");
  });
});
