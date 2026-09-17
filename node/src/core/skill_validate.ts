/** SKILL.md upload validation (N3, first phase): parse the YAML frontmatter
 * and check the minimal contract (name + description) before any skill is
 * staged. Registry registration itself stays out of scope until N4. */

import { load as loadYaml } from "js-yaml";

export interface SkillMarkdownValidation {
  valid: boolean;
  errors: string[];
  name?: string;
  description?: string;
}

/** A skill id becomes a first-class tool name (dashes -> underscores), so it
 * must be a sane identifier: lowercase start, letters/digits/dash/underscore. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function validateSkillMarkdown(content: string): SkillMarkdownValidation {
  const errors: string[] = [];
  const trimmed = (content ?? "").trim();
  if (!trimmed) {
    return { valid: false, errors: ["SKILL.md is empty"] };
  }

  // frontmatter must be a leading --- fenced YAML block
  if (!trimmed.startsWith("---")) {
    return { valid: false, errors: ["SKILL.md must start with a '---' YAML frontmatter block"] };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) {
    return { valid: false, errors: ["SKILL.md frontmatter is missing its closing '---'"] };
  }
  const rawFront = trimmed.slice(3, end).trim();
  let front: Record<string, unknown>;
  try {
    const parsed = loadYaml(rawFront);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, errors: ["SKILL.md frontmatter must be a YAML mapping"] };
    }
    front = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      valid: false,
      errors: [
        `SKILL.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const name = front.name;
  const description = front.description;
  if (typeof name !== "string" || !name.trim()) {
    errors.push("frontmatter 'name' is required and must be a non-empty string");
  } else if (!NAME_RE.test(name)) {
    errors.push(
      `frontmatter 'name' ${JSON.stringify(name)} is not a valid skill id ` +
        "(lowercase letters/digits, starting with a letter or digit)",
    );
  }
  if (typeof description !== "string" || !description.trim()) {
    errors.push("frontmatter 'description' is required and must be a non-empty string");
  }

  return {
    valid: errors.length === 0,
    errors,
    name: typeof name === "string" ? name : undefined,
    description: typeof description === "string" ? description : undefined,
  };
}
