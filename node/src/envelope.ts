/** Envelope contract shared by every skill, script and agent alike (port of hub/envelope.py).
 *
 * Request  (hub -> skill via stdin):  {request_id, action, inputs, context, dry_run}
 * Response (skill -> hub via stdout): {status, summary, data, artifacts, warnings}
 */

export const ENVELOPE_KEYS = ["status", "summary", "data", "artifacts", "warnings"] as const;

/** In-band contract version, stamped by the hub on every request and response
 * envelope (never taken from skill output). Bump on breaking envelope changes. */
export const ENVELOPE_VERSION = 1;

export interface Envelope {
  v: number;
  status: string;
  summary: string;
  data: Record<string, unknown>;
  artifacts: unknown[];
  warnings: string[];
  duration_ms?: number;
}

export function buildRequest(
  skillId: string,
  inputs: Record<string, unknown>,
  { dryRun = true, client = "" }: { dryRun?: boolean; client?: string } = {},
): string {
  // multi-action convention: if the caller supplies inputs["action"], it is
  // mirrored into the envelope so skills can dispatch on it; it also stays
  // in inputs, so a skill may read it from either place.
  const action =
    inputs !== null && typeof inputs === "object" && "action" in inputs
      ? String((inputs as Record<string, unknown>).action)
      : "run";
  const request = {
    v: ENVELOPE_VERSION,
    request_id: `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    action,
    skill_id: skillId,
    inputs,
    context: { client },
    dry_run: Boolean(dryRun),
  };
  return JSON.stringify(request);
}

const FENCED_JSON = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;

export function parseEnvelope(raw: string | null | undefined): Envelope {
  /** Parse a skill response envelope, tolerating agent-style prose or fences. */
  const text = (raw ?? "").trim();
  if (!text) {
    throw new Error("Skill produced no output");
  }

  const candidates: string[] = [text];
  for (const match of text.matchAll(FENCED_JSON)) {
    if (match[1]) candidates.push(match[1]);
  }
  // last balanced {...} block anywhere in the text (agents prepend chatter)
  let start = text.lastIndexOf("{");
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
    // port note: Python's rfind("{", 0, start) returns -1 at start==0, while
    // JS lastIndexOf treats a negative fromIndex as "search from the end",
    // which would re-find index 0 and loop forever — hence the guard
    start = start > 0 ? text.lastIndexOf("{", start - 1) : -1;
  }

  for (const candidate of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      "status" in data
    ) {
      return normalizeEnvelope(data as Record<string, unknown>);
    }
  }
  throw new Error(
    "Skill output did not contain a valid envelope " +
      `(expected JSON with a 'status' key); got: ${JSON.stringify(text.slice(0, 300))}`,
  );
}

function normalizeEnvelope(data: Record<string, unknown>): Envelope {
  const warnings = data.warnings;
  return {
    v: ENVELOPE_VERSION,
    status: (data.status as string) || "error",
    summary: (data.summary as string) || "",
    data:
      data.data !== null && typeof data.data === "object" && !Array.isArray(data.data)
        ? (data.data as Record<string, unknown>)
        : {},
    artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
    warnings: Array.isArray(warnings) ? (warnings as string[]) : [],
  };
}

export function errorEnvelope(message: string): Envelope {
  return {
    v: ENVELOPE_VERSION,
    status: "error",
    summary: message,
    data: {},
    artifacts: [],
    warnings: [],
  };
}
