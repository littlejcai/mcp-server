/** SKILL.md upload phase-1 validation (N3): frontmatter contract only. */

import { describe, expect, it } from "./expect.js";
import { validateSkillMarkdown } from "../src/core/skill_validate.js";

const VALID = `---
name: my-skill
description: A short description of what it does.
---

# Instructions

Body text for the agent.
`;

describe("validateSkillMarkdown", () => {
  it("accepts a well-formed SKILL.md", () => {
    const r = validateSkillMarkdown(VALID);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.name).toBe("my-skill");
    expect(r.description).toContain("short description");
  });

  it("rejects empty content", () => {
    const r = validateSkillMarkdown("   ");
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects content without a frontmatter fence", () => {
    const r = validateSkillMarkdown("name: my-skill\n---\nbody");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("frontmatter");
  });

  it("rejects an unclosed frontmatter block", () => {
    const r = validateSkillMarkdown("---\nname: my-skill\n");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("closing");
  });

  it("rejects malformed YAML", () => {
    const r = validateSkillMarkdown("---\nname: [unclosed\n---\nbody");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("not valid YAML");
  });

  it("rejects a non-mapping frontmatter", () => {
    const r = validateSkillMarkdown("---\n- just\n- a\n- list\n---\nbody");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("mapping");
  });

  it("rejects a missing name", () => {
    const r = validateSkillMarkdown("---\ndescription: no name here\n---\nbody");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("name");
  });

  it("rejects an invalid name pattern", () => {
    const r = validateSkillMarkdown(
      "---\nname: 'Bad Name!'\ndescription: ok\n---\nbody",
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("not a valid skill id");
  });

  it("rejects a missing description", () => {
    const r = validateSkillMarkdown("---\nname: my-skill\n---\nbody");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("description");
  });

  it("reports multiple errors together", () => {
    const r = validateSkillMarkdown("---\nfoo: bar\n---\nbody");
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBe(2);
  });
});
