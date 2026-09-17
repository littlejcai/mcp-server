/** Security primitives: path containment, subprocess environment, output
 * sanitizing (port of hub/security.py).
 *
 * v1 honest threat model (no containers yet):
 *   - all file arguments are confined to the workspace by resolve()-based checks
 *   - subprocesses never see the full parent environment
 *   - command lines are always argv arrays, never shell strings
 *   - stderr/stdout are truncated and scrubbed before leaving the process
 */

import { accessSync, constants, realpathSync } from "node:fs";
import * as path from "node:path";

import { SkillInputError } from "./errors.js";

// Minimal environment every Windows child process needs to boot sanely.
export const WINDOWS_BASE_ENV = [
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PATH",
  "TEMP",
  "TMP",
  "PROGRAMFILES",
  "COMMONPROGRAMFILES",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "OS",
];

// Extra entries the Claude Code CLI needs to locate its config/credentials.
export const AGENT_BASE_ENV = [
  ...WINDOWS_BASE_ENV,
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
];

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /(api[_-]?key|token|password|secret)\s*[=:]\s*\S+/gi,
];

/** realpath for the existing prefix of a path; lexical fallback for the rest.
 * Equivalent of Python's Path.resolve(strict=False): symlinks in the existing
 * part are resolved, a non-existent tail is normalized lexically. */
function resolveLoose(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function containsDir(rootDir: string, candidate: string): boolean {
  if (process.platform === "win32") {
    const r = rootDir.toLowerCase();
    const c = candidate.toLowerCase();
    return c === r || c.startsWith(r + path.sep);
  }
  return candidate === rootDir || candidate.startsWith(rootDir + path.sep);
}

export class PathGuard {
  /** Resolves untrusted path strings and confines them to allowed roots. */
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = resolveLoose(workspaceRoot);
  }

  /** Resolve a registry-declared permission path against the workspace. */
  allowedRoot(configured: string): string {
    return resolveLoose(
      path.isAbsolute(configured) ? configured : path.join(this.root, configured),
    );
  }

  /** Resolve `value` and require it to land inside one of `allowed` roots.
   *
   * Falls back to the whole workspace when `allowed` is omitted. Symlinks are
   * handled by resolving first, then checking containment of the final target.
   */
  resolve(
    value: unknown,
    {
      allowed,
      mustExist = false,
    }: { allowed?: string[]; mustExist?: boolean } = {},
  ): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new SkillInputError("Path argument must be a non-empty string");
    }
    if (value.includes("\x00")) {
      throw new SkillInputError("Path argument contains a null byte");
    }

    const roots = (allowed ?? ["."]).map((r) => this.allowedRoot(r));
    const lexical = path.isAbsolute(value)
      ? path.resolve(value)
      : path.join(this.root, value);
    const resolved = resolveLoose(lexical);

    if (!roots.some((r) => containsDir(r, resolved))) {
      throw new SkillInputError(
        `Path ${JSON.stringify(value)} resolves outside the allowed workspace roots`,
      );
    }
    if (mustExist && !existsPlain(resolved)) {
      throw new SkillInputError(`Path ${JSON.stringify(value)} does not exist`);
    }
    return resolved;
  }
}

function existsPlain(p: string): boolean {
  try {
    accessSync(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function buildEnv(
  allow: string[],
  { agent = false }: { agent?: boolean } = {},
): Record<string, string> {
  /** Base (Windows or agent) environment plus an explicit per-skill allowlist. */
  const base = agent ? AGENT_BASE_ENV : WINDOWS_BASE_ENV;
  const names = [...new Set([...base, ...allow])];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export function scrub(text: string, limit = 2000): string {
  /** Truncate and mask anything that looks like a credential. */
  if (!text) return "";
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  if (out.length > limit) {
    out = out.slice(0, limit) + `... [truncated ${out.length - limit} chars]`;
  }
  return out;
}
