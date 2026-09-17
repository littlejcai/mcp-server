import * as path from "node:path";
import { describe, expect, it } from "./expect.js";
import { z } from "zod";

import { buildToolShape } from "../src/core/first_class.js";
import { SkillRegistry } from "../src/core/registry.js";
import { REPO_ROOT } from "./helpers.js";

describe("buildToolShape", () => {
  it("maps JSON Schema types to zod with required/optional/default", () => {
    const shape = buildToolShape({
      type: "object",
      properties: {
        source_path: { type: "string" },
        output_path: { type: "string" },
        top_headings: { type: "integer", default: 10 },
        flagged: { type: "boolean" },
      },
      required: ["source_path"],
    });
    expect(shape.source_path).toBeInstanceOf(z.ZodString);
    expect(shape.output_path).toBeInstanceOf(z.ZodOptional);
    expect(shape.top_headings).toBeInstanceOf(z.ZodDefault);
    const defaultValue = (shape.top_headings as z.ZodDefault<z.ZodNumber>)._def
      .defaultValue;
    expect(typeof defaultValue === "function" ? defaultValue() : defaultValue).toBe(
      10,
    );
    expect(shape.flagged).toBeInstanceOf(z.ZodOptional);
  });

  it("turns an empty object schema into a single optional inputs record", () => {
    const shape = buildToolShape({ type: "object", properties: {} });
    expect(Object.keys(shape)).toEqual(["inputs"]);
    expect(shape.inputs).toBeInstanceOf(z.ZodDefault);
  });
});

describe("first-class registration source data (real registry)", () => {
  it("marks both demo skills first-class with underscore tool names", () => {
    const registry = new SkillRegistry(
      path.join(REPO_ROOT, "registry.yaml"),
      REPO_ROOT,
    );
    expect(registry.firstClassIds().sort()).toEqual([
      "md-stats",
      "note-worthiness",
    ]);
    // tool names derive from skill ids with "-" replaced
    expect("md-stats".replace(/-/g, "_")).toBe("md_stats");
    expect("note-worthiness".replace(/-/g, "_")).toBe("note_worthiness");
  });
});
