/** Execution core shared by the MCP dispatcher tools (port of server._execute). */

import { AuditLog } from "./audit.js";
import { errorEnvelope, type Envelope } from "./envelope.js";
import { SkillExecutionError, SkillHubError } from "./errors.js";
import { ScriptRunner } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import { type SkillRegistry } from "./registry.js";

export class Hub {
  constructor(
    readonly registry: SkillRegistry,
    private readonly scriptRunner: ScriptRunner,
    private readonly audit: AuditLog,
    private readonly semaphore: Semaphore,
  ) {}

  async execute(
    skillId: string,
    inputs: Record<string, unknown> = {},
    dryRun = true,
    client = "",
  ): Promise<Envelope> {
    try {
      this.registry.validateInputs(skillId, inputs);
      const runner = this.runnerFor(skillId);
      const envelope = await this.semaphore.run(() =>
        runner.run(skillId, inputs, { dryRun, client }),
      );
      this.audit.record({
        skill_id: skillId,
        status: envelope.status,
        duration_ms: envelope.duration_ms ?? null,
        inputs_summary: summarizeInputs(inputs),
        client,
      });
      return envelope;
    } catch (err) {
      if (err instanceof SkillHubError) {
        this.audit.record({
          skill_id: skillId,
          status: "rejected",
          reason: err.message,
          client,
        });
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.audit.record({
        skill_id: skillId,
        status: "failed",
        reason: message,
        client,
      });
      throw new SkillHubError(`skill-hub internal error: ${message}`);
    }
  }

  private runnerFor(skillId: string): ScriptRunner {
    const type = this.registry.get(skillId).type;
    if (type === "agent") {
      // N1 brings AgentRunner with the full-parity milestone.
      throw new SkillExecutionError(
        `Agent-type skill ${JSON.stringify(skillId)} is not served by the Node MVP (planned milestone N1)`,
      );
    }
    return this.scriptRunner;
  }
}

function summarizeInputs(
  inputs: Record<string, unknown>,
  limit = 200,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => {
      const text = String(value);
      return [key, text.length <= limit ? text : text.slice(0, limit) + "…"];
    }),
  );
}

export { errorEnvelope };
