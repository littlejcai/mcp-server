/** Authorization (N3): map a calling client to a grant — allowed skills and
 * a risk ceiling. Security posture: with no `authorization` config the
 * Authorizer denies nothing (legacy behavior, "授权关掉后核心功能不回归");
 * once configured, unlisted clients get the default grant, which defaults
 * to deny-all. */

import { SkillHubError } from "./errors.js";

export type RiskLevel = "read_only" | "workspace_write" | "external_write";

/** Higher rank = more dangerous. Unknown/missing risk is ranked as the
 * highest so a mislabeled skill is never silently under-restricted. */
export const RISK_RANK: Record<string, number> = {
  read_only: 0,
  workspace_write: 1,
  external_write: 2,
};
export const MAX_RISK_RANK = Math.max(...Object.values(RISK_RANK));

export class AuthorizationError extends SkillHubError {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface Grant {
  /** Allowed skill ids; unset = all skills. Empty array = nothing. */
  skills?: string[];
  /** Highest allowed risk level; unset = unlimited. */
  risk_limit?: RiskLevel;
}

export interface AuthorizationPolicy {
  /** Grant applied to clients not listed in `clients`. */
  defaultGrant: Grant;
  clients: Record<string, Grant>;
}

const DENY_ALL: Grant = { skills: [] };

/** No `authorization` config: everything is allowed (authorization off). */
export function denyNonePolicy(): AuthorizationPolicy {
  return { defaultGrant: {}, clients: {} };
}

/** Parse the config.yaml `authorization` section. Absent config -> allow all;
 * present config -> unlisted clients fall back to `default`, which defaults
 * to deny-all. */
export function loadPolicy(raw: unknown): AuthorizationPolicy {
  if (raw === undefined || raw === null) return denyNonePolicy();
  const obj = raw as { default?: Grant; clients?: Record<string, Grant> };
  return {
    defaultGrant: obj.default ?? DENY_ALL,
    clients: obj.clients ?? {},
  };
}

export class Authorizer {
  constructor(private readonly policy: AuthorizationPolicy) {}

  /** Throw AuthorizationError if `client` may not call `skillId` given its
   * risk level. riskLevel undefined ("unknown") ranks as the highest risk. */
  authorize(client: string, skillId: string, riskLevel: string | undefined): void {
    const grant = this.policy.clients[client] ?? this.policy.defaultGrant;
    if (grant.skills !== undefined && !grant.skills.includes(skillId)) {
      throw new AuthorizationError(
        `Client ${JSON.stringify(client)} is not granted skill ${JSON.stringify(skillId)}`,
      );
    }
    if (grant.risk_limit !== undefined) {
      const rank = RISK_RANK[riskLevel ?? ""] ?? MAX_RISK_RANK;
      const limit = RISK_RANK[grant.risk_limit] ?? 0;
      if (rank > limit) {
        throw new AuthorizationError(
          `Client ${JSON.stringify(client)} risk limit ${grant.risk_limit} ` +
            `forbids skill ${JSON.stringify(skillId)} (risk ${riskLevel ?? "unknown"})`,
        );
      }
    }
  }
}
