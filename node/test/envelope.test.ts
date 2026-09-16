import { describe, expect, it } from "./expect.js";

import { ENVELOPE_VERSION, buildRequest, errorEnvelope, parseEnvelope } from "../src/envelope.js";

describe("parseEnvelope", () => {
  it("parses a plain JSON envelope and normalizes fields", () => {
    const env = parseEnvelope(
      JSON.stringify({ status: "success", summary: "ok", data: { words: 12 } }),
    );
    expect(env.status).toBe("success");
    expect(env.summary).toBe("ok");
    expect(env.data).toEqual({ words: 12 });
    expect(env.artifacts).toEqual([]);
    expect(env.warnings).toEqual([]);
    expect(env.v).toBe(ENVELOPE_VERSION);
  });

  it("fills defaults for missing keys", () => {
    const env = parseEnvelope('{"status": "error"}');
    expect(env).toMatchObject({
      v: ENVELOPE_VERSION,
      status: "error",
      summary: "",
      data: {},
      artifacts: [],
      warnings: [],
    });
  });

  it("stamps v itself, never trusting skill output", () => {
    const env = parseEnvelope('{"v": 99, "status": "success"}');
    expect(env.v).toBe(ENVELOPE_VERSION);
  });

  it("extracts JSON from a fenced block", () => {
    const env = parseEnvelope(
      'Here you go:\n```json\n{"status": "success"}\n```\nDone.',
    );
    expect(env.status).toBe("success");
  });

  it("finds the last balanced JSON object after agent chatter", () => {
    const env = parseEnvelope(
      'I considered {"a": 1} but the real answer is {"status": "success", "summary": "s"}',
    );
    expect(env.summary).toBe("s");
  });

  it("rejects empty output", () => {
    expect(() => parseEnvelope("")).toThrow(/no output/);
  });

  it("rejects output without an envelope", () => {
    expect(() => parseEnvelope("just prose, no json")).toThrow(
      /did not contain a valid envelope/,
    );
  });
});

describe("buildRequest", () => {
  it("mirrors inputs.action and keeps it in inputs", () => {
    const req = JSON.parse(buildRequest("s", { action: "special", x: 1 }));
    expect(req.v).toBe(ENVELOPE_VERSION);
    expect(req.action).toBe("special");
    expect(req.inputs.action).toBe("special");
    expect(req.skill_id).toBe("s");
    expect(req.dry_run).toBe(true);
    expect(req.request_id).toMatch(/^req_[0-9a-f]{12}$/);
  });

  it("defaults action to run and honors dry_run=false", () => {
    const req = JSON.parse(buildRequest("s", {}, { dryRun: false, client: "c" }));
    expect(req.action).toBe("run");
    expect(req.dry_run).toBe(false);
    expect(req.context).toEqual({ client: "c" });
  });
});

describe("errorEnvelope", () => {
  it("has the error shape", () => {
    expect(errorEnvelope("bad")).toEqual({
      v: ENVELOPE_VERSION,
      status: "error",
      summary: "bad",
      data: {},
      artifacts: [],
      warnings: [],
    });
  });
});
